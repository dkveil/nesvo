import { useState, type ReactNode } from 'react';
import type {
  Computer,
  DesktopApi,
  DesktopScheduledJob,
  HostCapability,
} from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  providerUsable,
  type ProviderStates,
} from '@/entities/session';
import { useTrackedRepositories } from '@/entities/tracked-repository';
import { useReviewProfiles } from '@/features/edit-automation';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  morningSummaryJob,
  prePushDefinitions,
  pullRequestReviewJob,
  type StarterJob,
} from './starter-routines';

type Api = Pick<
  DesktopApi,
  | 'scheduledJobs'
  | 'workflows'
  | 'readCodeReviewSettings'
  | 'listTrackedRepositories'
>;

type Props = {
  api: Api;
  computer: Computer | undefined;
  statuses: ProviderStates;
  defaultFolder: string | null;
  onJobAdded: (job: DesktopScheduledJob) => void;
};

type Outcome = { status: 'pending' | 'added' | 'error'; message: string };

type RoutineId = 'morning' | 'review' | 'workflow';

type RoutineRowProps = {
  title: string;
  summary: string;
  outcome: Outcome | undefined;
  disabled: boolean;
  label?: string;
  onAdd: () => void;
};

function RoutineRow({
  title,
  summary,
  outcome,
  disabled,
  label = 'Add',
  onAdd,
}: RoutineRowProps) {
  const pending = outcome?.status === 'pending';
  const added = outcome?.status === 'added';
  let note: ReactNode = null;
  if (outcome && !pending)
    note = (
      <StatusMessage tone={added ? 'success' : 'error'}>
        {outcome.message}
      </StatusMessage>
    );
  return (
    <SettingsRow
      title={title}
      description={
        <div className="space-y-1">
          <p>{summary}</p>
          {note}
        </div>
      }
    >
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || pending || added}
        onClick={onAdd}
      >
        {added ? 'Added' : pending ? 'Adding…' : label}
      </Button>
    </SettingsRow>
  );
}

export function RoutinesStep({
  api,
  computer,
  statuses,
  defaultFolder,
  onJobAdded,
}: Props) {
  const hostId = computer?.id ?? 'local';
  const connected = computer?.status === 'connected';
  const capable = (capability: HostCapability) =>
    connected && !!computer?.capabilities.includes(capability);
  const [outcomes, setOutcomes] = useState<Partial<Record<RoutineId, Outcome>>>(
    {},
  );
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState(defaultFolder ?? '');
  const reviewsSupported =
    capable('pull-request-reviews') && capable('tracked-repositories');
  const profiles = useReviewProfiles(api, hostId, reviewsSupported);
  const tracked = useTrackedRepositories(api, hostId, reviewsSupported);
  const repository = tracked.repositories.find(item => item.directory);
  const profile = profiles.profiles[0];
  const provider = providers.find(item => providerUsable(statuses[item]));
  const record = (id: RoutineId, outcome: Outcome) =>
    setOutcomes(previous => ({ ...previous, [id]: outcome }));
  const run = async (id: RoutineId, operation: () => Promise<string>) => {
    if (outcomes[id]?.status === 'pending') return;
    record(id, { status: 'pending', message: '' });
    try {
      record(id, { status: 'added', message: await operation() });
    } catch (failure) {
      record(id, { status: 'error', message: errorDetail(failure) });
    }
  };
  const saveJob = async (input: StarterJob | string) => {
    if (typeof input === 'string') throw new Error(input);
    const job = await api.scheduledJobs.save(hostId, input, null);
    onJobAdded(job);
    return `Added “${job.name}” to Automations, paused. Review it before turning it on.`;
  };
  const addWorkflow = async () => {
    const directory = target.trim();
    const catalog = await api.workflows.listDefinitions(hostId, { directory });
    const names = new Set(prePushDefinitions.map(item => item.name));
    const taken = [...catalog.steps, ...catalog.workflows].find(
      item => names.has(item.name) && item.source.scope === 'project',
    );
    if (taken)
      throw new Error(
        `“${taken.name}” already exists in ${catalog.roots.project ?? directory}. Nothing was written.`,
      );
    let root = catalog.roots.project ?? directory;
    for (const definition of prePushDefinitions) {
      const result = await api.workflows.saveDefinition(hostId, {
        directory,
        scope: 'project',
        kind: definition.kind,
        name: definition.name,
        document: definition.document,
        expectedHash: null,
      });
      if ('type' in result && result.type === 'workflow-definition-conflict')
        throw new Error(
          `“${definition.name}” already exists at ${result.path}.`,
        );
      if ('type' in result)
        throw new Error(
          result.issues.map(issue => issue.message).join(' ') ||
            `“${definition.name}” was refused.`,
        );
      if (result.roots.project) root = result.roots.project;
    }
    return `Added the ${prePushDefinitions.at(-1)?.name} workflow to ${root}.`;
  };
  const morningReason = !capable('scheduled-jobs')
    ? 'Needs a connected computer with automations.'
    : !provider
      ? 'Set up Claude Code or Codex first.'
      : !defaultFolder
        ? 'Set a default session folder first.'
        : '';
  const reviewReason = !reviewsSupported
    ? 'Needs a computer with pull request reviews.'
    : !repository
      ? 'Track a repository with a local checkout in Settings › Tracked repositories first.'
      : !profile
        ? 'Add a reviewer profile in Settings › Code review first.'
        : '';
  const workflowReason = capable('workflows')
    ? ''
    : 'Needs a computer with workflows.';
  return (
    <div className="space-y-3">
      <SettingsSection title="Starter routines">
        <RoutineRow
          title="Morning summary of yesterday’s work"
          summary={
            morningReason ||
            `Weekdays at 08:30 in ${defaultFolder}. Asks before starting when there are new commits since yesterday.`
          }
          outcome={outcomes.morning}
          disabled={!!morningReason}
          onAdd={() =>
            void run('morning', () =>
              saveJob(
                morningSummaryJob({
                  hostId,
                  provider: provider ?? 'Claude Code',
                  directory: defaultFolder ?? '',
                  askFirst: capable('scheduled-job-change-triggers'),
                }),
              ),
            )
          }
        />
        <RoutineRow
          title="Review new pull requests in a tracked repository"
          summary={
            reviewReason ||
            `Hourly in ${repository?.repository} with the ${profile?.name} reviewer. Asks before starting.`
          }
          outcome={outcomes.review}
          disabled={!!reviewReason}
          onAdd={() => {
            if (!repository?.directory || !profile) return;
            void run('review', () =>
              saveJob(
                pullRequestReviewJob({
                  hostId,
                  profile,
                  directory: repository.directory ?? '',
                  repository: repository.repository,
                }),
              ),
            );
          }}
        />
        <RoutineRow
          title="Pre-push gates workflow"
          summary={
            workflowReason ||
            'Lint, a diff probe, a review loop and a wait for pull request checks, as editable files in your project.'
          }
          outcome={outcomes.workflow}
          disabled={!!workflowReason}
          label="Add…"
          onAdd={() => {
            setTarget(defaultFolder ?? '');
            setConfirming(true);
          }}
        />
      </SettingsSection>
      <p className="px-3 text-xs leading-5 text-muted-foreground">
        Nothing runs automatically. Automations are added paused and every
        routine stays editable.
      </p>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="default"
        title="Add the pre-push gates workflow?"
        description="Nesvo writes four step files and one workflow file to .agents/workflows in the project that contains this folder. Existing files are never overwritten."
        confirmLabel="Write files"
        pendingLabel="Writing…"
        onConfirm={() => {
          if (!target.trim()) return false;
          return run('workflow', addWorkflow);
        }}
      >
        <Field
          id="onboarding-workflow-folder"
          label="Project folder"
          hint={`An absolute path on ${computer?.name ?? 'this computer'}.`}
        >
          <Input
            id="onboarding-workflow-folder"
            size="md"
            className="font-mono"
            spellCheck={false}
            maxLength={4096}
            value={target}
            onChange={event => setTarget(event.target.value)}
          />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
