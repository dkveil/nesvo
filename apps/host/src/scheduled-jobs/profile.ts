import {
  directCommandSchema,
  scheduledJobDefinitionSchema,
  type DirectCommand,
  type ScheduledJob,
  type ScheduledJobDefinition,
  type SetupProfileAutomation,
} from '@nesvo/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  inspectDirectCommand,
  runDirectCommand,
} from '../process/direct-command';
import {
  readSetupProfile,
  type LoadedSetupProfile,
} from '../setup-profile-file';
import { activeSetupProfile } from '../setup-profile-service';
import { type SetupReviewInspection } from '../setup-profile-review-queue';
import {
  configurationHash,
  ConfigurationRefusal,
  configurationText,
} from '../workflows/configuration-changes';
import {
  loadCatalog,
  loadSpec,
  resolveWorkflow,
} from '../workflows/definitions';
import { profileWorkflowIdentity } from './profile-workflow-identity';
import type { ScheduledJobService } from './service';

type Binding = {
  id: string;
  declaration: string;
  profile: string;
  revision: string;
  fingerprint: string;
  retired: number;
  generation: number;
};
type Command = Awaited<ReturnType<typeof inspectDirectCommand>> & {
  definition: DirectCommand;
};
type ResolvedJob = {
  fingerprint: string;
  definition: ScheduledJobDefinition;
  task?: Command;
  check?: Command;
  workflowIdentity?: string;
};
const digest = (data: unknown) => configurationHash(JSON.stringify(data));

const starterRituals: Readonly<Record<string, string>> = {
  'morning-summary':
    'Summarize the work in this folder since yesterday morning: the commits, branches and changed files, anything left unfinished, and the first task worth picking up today. Do not change any files.',
};

function stableJobId(instanceId: string, id: string) {
  const key = digest([instanceId, 'automation', id]);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

function authorityRevision(
  profile: LoadedSetupProfile,
  job: SetupProfileAutomation,
) {
  const task = job.task;
  const ritual =
    task.kind === 'ritual'
      ? profile.portable?.rituals?.find(ritual => ritual.id === task.name)
      : undefined;
  return digest([job, ritual ?? null]);
}

function definition(profile: LoadedSetupProfile, id: string) {
  const entry = profile.portable?.automations?.find(item => item.id === id);
  return entry && !('disabled' in entry) ? entry : undefined;
}

async function inspectCommand(
  desired: Extract<
    SetupProfileAutomation['task'],
    { kind: 'command' }
  >['command'],
  directory: string,
  scope: string,
  instanceId: string,
  signal: AbortSignal,
): Promise<Command> {
  const { environment, ...fields } = desired;
  if (environment?.length)
    throw new Error(
      'This computer cannot bind environment references for scheduled commands yet.',
    );
  const definition = directCommandSchema.parse(fields);
  return {
    definition,
    ...(await inspectDirectCommand(
      definition,
      directory,
      scope,
      instanceId,
      signal,
    )),
  };
}

async function resolveJob(
  profile: LoadedSetupProfile,
  job: SetupProfileAutomation,
  instanceId: string,
  signal: AbortSignal,
): Promise<ResolvedJob> {
  if (!job.provider || !job.model)
    throw new Error(
      'Select a provider and model in this automation declaration.',
    );
  if (!isAbsolute(job.directory))
    throw new Error('Use an absolute automation folder on this computer.');
  const directory = await realpath(job.directory);
  const scope = JSON.stringify([profile.path, job.id, directory]);
  const task =
    job.task.kind === 'command'
      ? await inspectCommand(
          job.task.command,
          directory,
          scope + ':task',
          instanceId,
          signal,
        )
      : undefined;
  const check = job.check
    ? await inspectCommand(
        job.check,
        directory,
        scope + ':check',
        instanceId,
        signal,
      )
    : undefined;
  let workflow: ScheduledJobDefinition['workflow'] = null;
  let workflowIdentity: string | undefined;
  let prompt = task ? 'Run the locally reviewed direct task.' : '';
  if (job.task.kind === 'workflow') {
    const catalog = await loadCatalog(directory, signal);
    const selected = resolveWorkflow(job.task.name, catalog);
    const specs = catalog.specs.filter(spec => spec.workflow === selected.name);
    const specPath = job.task.spec
      ? resolve(directory, job.task.spec)
      : specs.length === 1
        ? specs[0]!.source.path
        : undefined;
    if (!specPath)
      throw new Error('Choose a single task spec for this workflow.');
    const spec = await loadSpec(specPath, directory, signal);
    if (spec.spec.workflow !== selected.name)
      throw new Error('Choose a task spec for the declared workflow.');
    workflowIdentity = profileWorkflowIdentity(selected, spec.source);
    workflow = { name: selected.name, specPath: spec.source.path };
  } else if (job.task.kind === 'ritual') {
    const name = job.task.name;
    const ritual = profile.portable?.rituals?.find(item => item.id === name);
    const resolved = ritual
      ? 'disabled' in ritual
        ? undefined
        : ritual.prompt
      : starterRituals[name];
    if (!resolved)
      throw new Error('Choose an available ritual in the profile.');
    prompt = resolved;
  }
  const parsed = scheduledJobDefinitionSchema.safeParse({
    name: job.name,
    provider: job.provider === 'Claude Code' ? 'claude' : 'codex',
    model: job.model,
    effort: job.effort ?? null,
    mode: 'read-only',
    active: false,
    timeZone: job.timeZone,
    schedule: { kind: 'daily', time: job.schedule },
    directory,
    workflow,
    prompt,
    ...(check
      ? {
          changeTrigger: {
            argv: [check.executable, ...check.definition.argv],
            dailyRunCap: job.maxRunsPerDay ?? 3,
            askFirst: job.askFirst ?? true,
          },
        }
      : {}),
  });
  if (!parsed.success)
    throw new Error(
      'Check the automation name, provider, model, schedule and command limits.',
    );
  return {
    definition: parsed.data,
    fingerprint: digest([
      scope,
      authorityRevision(profile, job),
      task?.fingerprint,
      check?.fingerprint,
      workflowIdentity,
    ]),
    task,
    check,
    workflowIdentity,
  };
}

export class ProfileAutomations {
  service?: ScheduledJobService;

  constructor(
    private readonly database: DatabaseSync,
    private readonly instanceId: string,
    private readonly signal: AbortSignal,
  ) {}

  binding(id: string) {
    return this.database
      .prepare('SELECT * FROM setup_automation_bindings WHERE id = ?')
      .get(id) as Binding | undefined;
  }

  inspect: SetupReviewInspection = async (profile, declaration) => {
    if (!declaration.key.startsWith('automations/')) return undefined;
    const job = definition(
      profile,
      declaration.key.slice('automations/'.length),
    );
    if (!job) return undefined;
    const id = stableJobId(this.instanceId, job.id);
    try {
      const resolved = await resolveJob(
        profile,
        job,
        this.instanceId,
        this.signal,
      );
      const reviewedRevision = authorityRevision(profile, job);
      const generation = this.binding(id)?.generation ?? 0;
      return {
        fingerprint: digest([resolved.fingerprint, generation]),
        description: [
          'Save a paused automation with this reviewed definition.',
          `${resolved.definition.name} · ${job.schedule} · ${job.timeZone}`,
          `${job.provider} · ${job.model}`,
          'Folder: ' + resolved.definition.directory,
          ...(resolved.task
            ? [
                'Task: ' +
                  JSON.stringify([
                    resolved.task.executable,
                    ...resolved.task.definition.argv,
                  ]),
              ]
            : []),
          ...(resolved.check
            ? [
                'Check: ' +
                  JSON.stringify([
                    resolved.check.executable,
                    ...resolved.check.definition.argv,
                  ]),
              ]
            : []),
          ...(resolved.definition.workflow
            ? ['Workflow: ' + resolved.definition.workflow.specPath]
            : []),
          'Verified digest: ' + resolved.fingerprint,
        ]
          .map(configurationText)
          .join('\n'),
        accept: () => {
          const service = this.service!;
          const current = service.list().find(item => item.id === id);
          if (current && !this.binding(id))
            throw new ConfigurationRefusal(
              'conflict',
              'This automation identity already belongs to a manual job.',
            );
          this.database
            .prepare(
              `
            INSERT INTO setup_automation_bindings (id, declaration, profile, revision, fingerprint)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, revision = excluded.revision,
              fingerprint = excluded.fingerprint, retired = 0
          `,
            )
            .run(
              id,
              job.id,
              profile.path,
              reviewedRevision,
              resolved.fingerprint,
            );
          service.save(
            {
              ...resolved.definition,
              id,
              expectedRevision: current?.revision ?? null,
            },
            'profile',
          );
        },
        applied: () => {
          const binding = this.binding(id);
          return (
            binding?.fingerprint === resolved.fingerprint &&
            binding.profile === profile.path &&
            !binding.retired
          );
        },
        revoke: () => this.retire(id),
      };
    } catch (error) {
      return configurationText(
        error instanceof Error
          ? error.message
          : 'The automation could not be verified.',
      ).slice(0, 300);
    }
  };

  desired(binding: Binding, profile = activeSetupProfile(this.database)) {
    if (!profile || profile.path !== binding.profile) return undefined;
    return definition(profile, binding.declaration);
  }

  reconcile(profile = activeSetupProfile(this.database) ?? null) {
    for (const job of this.service?.list() ?? []) {
      const binding = this.binding(job.id);
      if (!binding) continue;
      const desired = this.desired(binding, profile ?? undefined);
      if (
        !desired ||
        !profile ||
        authorityRevision(profile, desired) !== binding.revision
      )
        this.retire(job.id);
    }
  }

  private retire(id: string) {
    this.database
      .prepare(
        'UPDATE setup_automation_bindings SET retired = 1, generation = generation + 1 WHERE id = ? AND retired = 0',
      )
      .run(id);
    const job = this.service?.list().find(item => item.id === id);
    if (job?.active)
      this.service!.setActive({
        id,
        expectedRevision: job.revision,
        active: false,
      });
  }

  assertReady(id: string) {
    const binding = this.binding(id);
    if (!binding) return;
    const selected = activeSetupProfile(this.database);
    try {
      const profile = readSetupProfile(binding.profile);
      const desired = this.desired(binding, profile);
      if (
        !binding.retired &&
        selected?.path === binding.profile &&
        selected.revision === profile.revision &&
        desired &&
        authorityRevision(profile, desired) === binding.revision
      )
        return;
    } catch {}
    throw new Error(
      'Review the current profile automation before starting it.',
    );
  }

  askFirst(id: string) {
    const binding = this.binding(id);
    return binding && (this.desired(binding)?.askFirst ?? true);
  }

  dailyCap(id: string) {
    const binding = this.binding(id);
    return binding ? (this.desired(binding)?.maxRunsPerDay ?? 3) : undefined;
  }

  async verify(job: ScheduledJob, signal: AbortSignal) {
    const binding = this.binding(job.id);
    if (!binding) return null;
    this.assertReady(job.id);
    const profile = readSetupProfile(binding.profile);
    const desired = this.desired(binding, profile)!;
    const reviewed = await resolveJob(
      profile,
      desired,
      this.instanceId,
      signal,
    );
    this.assertReady(job.id);
    if (
      reviewed.fingerprint !== binding.fingerprint ||
      this.binding(job.id)?.fingerprint !== binding.fingerprint
    )
      throw new Error(
        'The automation program, inputs or workflow changed. Review the current definition.',
      );
    return reviewed;
  }
}

export async function runProfileAutomationCommand(
  command: Command,
  signal: AbortSignal,
) {
  return runDirectCommand(command.definition, command, {}, signal);
}
