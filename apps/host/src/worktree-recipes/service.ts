import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  hasLegacyRecipeCommands,
  hasRecipeCommand,
  worktreeRecipeEnvironment,
  worktreeRecipeLimits,
  worktreeRecipeDefaults,
  worktreeRecipeContentSchema,
  type DecideSessionWorktreeRecipeInput,
  type DirectCommand,
  type SetupProfileRecipe,
  type SaveWorktreeRecipeInput,
  type Session,
  type StartWorktreeRecipeTrialInput,
  type WorktreeRecipe,
  type WorktreeRecipeMatch,
  type WorktreeRecipeRun,
  type WorktreeRecipeSnapshot,
  type WorktreeRecipeStep,
} from '@nesvo/contracts';
import { nativeProfileCommand } from '../setup-native-bindings';
import type { SetupReviewInspection } from '../setup-profile-review-queue';
import type { LoadedSetupProfile } from '../setup-profile-file';
import { configurationHash } from '../workflows/configuration-changes';
import { inspectRepositoryIdentity, matchesRepositoryPattern } from '../repositories/identity';
import { redactLogMessage } from '../log-redaction';
import { inspectDirectCommand, runDirectCommand } from '../process/direct-command';
import { SessionError } from '../sessions/session-error';
import { resolveFolder } from '../workspace/folder';
import {
  repositoryGitDirectory,
  readSessionWorktreeStatus,
  repositoryRoot,
  runGit,
  sessionCheckout,
} from '../workspace/isolation';
import {
  executeWorktreeSetup,
  inspectWorktreeSetup,
} from '../workspace/worktree-setup';
import { readWorktreeFile } from '../workspace/worktree-files';
import { repositoryCandidates } from './repository-key';
import { createResources, removeTempDirectory } from './resources';
import {
  commandEnvironment,
  copyRecipeFiles,
  emptyStep,
  runRecipeCommand,
} from './steps';
import { recipeHash, type WorktreeRecipeStore } from './store';

const TRIAL_ROOT = 'worktree-recipe-trials';
const GIT_CHANGE_TIMEOUT_MS = 60_000;

type Live = {
  run: WorktreeRecipeRun;
  controller: AbortController;
  release: () => void;
  done: Promise<void> | null;
};

type Checkout = { projectDirectory: string; gitDirectory: string; binding?: NonNullable<Session['worktree']>['binding'] };

export type WorktreeRecipesParams = {
  dataDirectory: string;
  store: WorktreeRecipeStore;
  session: (id: string) => Session | undefined;
  claim: (sessionId: string) => () => void;
};

const now = () => new Date().toISOString();
const noop = () => undefined;

const errorText = (error: unknown, fallback: string) =>
  (error instanceof Error && error.message ? error.message : fallback).slice(
    0,
    worktreeRecipeLimits.error,
  );

const snapshotOf = (recipe: WorktreeRecipe): WorktreeRecipeSnapshot => ({
  id: recipe.id,
  name: recipe.name,
  repository: recipe.repository,
  sha256: recipe.sha256,
  copy: recipe.copy,
  setup: recipe.setup,
  cleanup: recipe.cleanup,
  environment: recipe.environment,
  resources: recipe.resources,
});

const recipeVariables = (run: WorktreeRecipeRun) => ({
  ...Object.fromEntries(
    run.recipe.environment.map(variable => [variable.name, variable.value]),
  ),
  ...(run.resources ? worktreeRecipeEnvironment(run.resources) : {}),
  ...Object.fromEntries((run.recipe.resources.portNames ?? []).flatMap((name, index) =>
    run.resources?.ports[index] ? [[name, String(run.resources.ports[index])]] : [],
  )),
});

const startStep = (step: WorktreeRecipeStep) => {
  step.status = 'running';
  step.startedAt = now();
};

const endStep = (
  step: WorktreeRecipeStep,
  result: Partial<WorktreeRecipeStep> & Pick<WorktreeRecipeStep, 'status'>,
) => {
  Object.assign(step, result, { completedAt: now() });
};

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;

export class WorktreeRecipes {
  private readonly live = new Map<string, Live>();
  private readonly trials = new Map<string, Live>();
  private allocation: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor(private readonly params: WorktreeRecipesParams) {
    this.recover();
  }

  async beforeProfileWorktree(directory: string, provider: string | undefined, signal: AbortSignal) {
    const declarations = this.params.store.setupProfile()?.desired?.recipes?.filter(
      (item): item is SetupProfileRecipe => 'repository' in item,
    ) ?? [];
    if (!declarations.length) return false;
    const identity = await inspectRepositoryIdentity(directory, signal);
    if (identity.status === 'ambiguous' || identity.status === 'unverified')
      throw new SessionError('invalid-request', 'Verify a single repository identity to select its profile recipe.');
    if (identity.status === 'local') return false;
    const rank = (item: SetupProfileRecipe) =>
      item.repository.split('/').filter(segment => segment !== '*').length;
    const matches = declarations.filter(item => matchesRepositoryPattern(item.repository, identity.remote))
      .sort((left, right) => rank(right) - rank(left));
    const selected = matches[0];
    if (!selected) return false;
    if (matches[1] && rank(selected) === rank(matches[1]))
      throw new SessionError('invalid-request', 'Resolve the competing profile recipes for this repository.');
    if (selected.provider && provider !== 'worktrees/' + selected.provider)
      throw new SessionError('invalid-request', 'Use the approved worktree provider required by this profile recipe.');
    const store = this.params.store;
    const recipe = store.forRepository([{ key: identity.remote.toLowerCase(), kind: 'remote', label: identity.remote }]);
    if (!recipe || store.profile.get(recipe.id)?.declaration !== 'recipes/' + selected.id ||
      !store.profile.passes(recipe.id) || !store.isApproved(recipe.sha256, identity.gitDirectory))
      throw new SessionError('invalid-request', 'Review the profile recipe for this checkout before creating a worktree.');
    if (!recipe.sourceDirectory)
      throw new SessionError('invalid-request', 'The recipe approval has no verified source checkout.');
    for (const kind of ['setup', 'cleanup'] as const) {
      const stage = recipe[kind];
      if (typeof stage.command === 'string') {
        if (stage.command.trim()) throw new SessionError('invalid-request', 'Profile recipes require direct commands.');
        continue;
      }
      const reviewed = await this.verifyChain(kind, stage.command, recipe.sourceDirectory, signal);
      if (reviewed.fingerprint !== stage.fingerprint)
        throw new SessionError('invalid-request', 'The recipe executable or its inputs changed. Review the current version.');
    }
    if (!store.profile.passes(recipe.id))
      throw new SessionError('invalid-request', 'The recipe approval changed while checking the worktree.');
    return true;
  }

  reconcileProfile(profile: LoadedSetupProfile | null) {
    this.params.store.profile.reconcile(profile);
  }

  inspectProfile(signal: AbortSignal): SetupReviewInspection {
    return async (profile, entry) => {
      if (!entry.key.startsWith('recipes/')) return undefined;
      const desired = profile.desired?.recipes?.find(item => entry.key === 'recipes/' + item.id);
      if (!desired || 'disabled' in desired) return undefined;
      const provider = profile.desired?.worktrees?.find(item => item.id === desired.provider);
      const directory = desired.directory ??
        (provider && 'scope' in provider && provider.scope.kind === 'repository' ? provider.scope.directory : undefined);
      if (!directory || !isAbsolute(directory))
        return 'Choose an absolute checkout for verifying this recipe on this computer.';
      try {
        const identity = await inspectRepositoryIdentity(directory, signal);
        if (identity.status !== 'remote' || !matchesRepositoryPattern(desired.repository, identity.remote))
          return 'The checkout does not have the single verified remote required by this recipe.';
        if (desired.name.length > worktreeRecipeLimits.name)
          return 'Use a shorter worktree recipe name.';
        const stage = (commands: NonNullable<typeof desired.setup>) => {
          if (!commands.length) return { command: '', timeoutSeconds: 1 };
          const definitions = commands.map(command => {
            const definition = nativeProfileCommand(command);
            return { ...definition, files: definition.files.map(file => resolve(identity.root, file)) };
          });
          return {
            command: definitions,
            timeoutSeconds: Math.ceil(definitions.reduce((total, command) => total + command.timeoutMs, 0) / 1000),
          };
        };
        const ports = desired.ports ?? [];
        if (ports.some(port => !/(?:^|_)PORT(?:_|$)/u.test(port) || port.startsWith('NESVO_')))
          return 'Use distinct port variable names such as PORT or WEB_PORT.';
        const content = worktreeRecipeContentSchema.parse({
          copy: {
            patterns: desired.copy ?? [],
            maxFiles: worktreeRecipeDefaults.maxFiles,
            maxBytes: worktreeRecipeDefaults.maxBytes,
          },
          setup: await this.pinStage('setup', stage(desired.setup ?? []), identity.root, signal),
          cleanup: await this.pinStage('cleanup', stage(desired.cleanup ?? []), identity.root, signal),
          environment: [],
          resources: {
            ports: ports.length,
            portNames: ports,
            portRange: worktreeRecipeDefaults.portRange,
            tag: true,
            tempDirectory: true,
          },
        });
        const repository = { key: identity.remote.toLowerCase(), kind: 'remote' as const, label: identity.remote };
        const store = this.params.store;
        const existing = store.forRepository([repository]);
        const sha256 = recipeHash(repository.key, content);
        const fingerprint = configurationHash(JSON.stringify([
          identity.gitDirectory, identity.remote, sha256,
          existing ? store.profile.get(existing.id)?.generation ?? 0 : 0,
        ]));
        return {
          fingerprint,
          description: [
            'Review setup and cleanup for ' + identity.remote + '.',
            'Checkout: ' + identity.root,
            'Copy: ' + (content.copy.patterns.join(', ') || 'none'),
            'Port variables: ' + (ports.join(', ') || 'none'),
            'Setup argv: ' + JSON.stringify(content.setup.command),
            'Cleanup argv: ' + JSON.stringify(content.cleanup.command),
            'Verified digest: ' + fingerprint,
          ].map(line => redactLogMessage(line)).join('\n'),
          accept: () => {
            const id = store.forRepository([repository])?.id ?? randomUUID();
            store.save({ ...content, id, repository, sha256, name: desired.name, sourceDirectory: identity.root, updatedAt: now() });
            store.profile.bind(id, profile, entry.key, entry.revision, fingerprint);
            store.approve(sha256, identity.gitDirectory);
          },
          applied: () => {
            const current = store.forRepository([repository]);
            return !!current && current.sha256 === sha256 &&
              store.profile.get(current.id)?.revision === entry.revision &&
              store.profile.passes(current.id) &&
              store.isApproved(sha256, identity.gitDirectory);
          },
          revoke: () => {
            const current = store.forRepository([repository]);
            if (current) store.profile.revoke(current.id);
          },
        };
      } catch (error) {
        return redactLogMessage(errorText(error, 'The direct recipe could not be verified.')).slice(0, 300);
      }
    };
  }

  list(): WorktreeRecipe[] {
    return this.params.store.list();
  }

  async save(
    input: SaveWorktreeRecipeInput,
    signal: AbortSignal,
  ): Promise<WorktreeRecipe[]> {
    const match = await this.inspect(input.directory, signal);
    const repository = match.recipe?.repository ?? match.candidates[0]!;
    const existing = input.id ? this.params.store.get(input.id) : undefined;
    if (input.id && !existing)
      throw new SessionError('not-found', 'This recipe no longer exists.');
    const owner = this.params.store.forRepository([repository]);
    if (owner && this.params.store.profile.get(owner.id))
      throw new SessionError('invalid-request', 'This recipe is managed by the profile. Edit it in Your setup.');
    if (owner && owner.id !== input.id)
      throw new SessionError(
        'invalid-request',
        `${repository.label} already has the recipe ${owner.name}. Edit that recipe instead.`,
      );
    const content = {
      copy: input.copy,
      setup: await this.pinStage('setup', input.setup, match.directory, signal),
      cleanup: await this.pinStage('cleanup', input.cleanup, match.directory, signal),
      environment: input.environment,
      resources: input.resources,
    };
    this.params.store.save({
      ...content,
      id: existing?.id ?? randomUUID(),
      name: input.name,
      repository,
      sourceDirectory: match.directory,
      sha256: recipeHash(repository.key, content),
      updatedAt: now(),
    });
    return this.list();
  }

  delete(id: string): WorktreeRecipe[] {
    if (this.params.store.profile.get(id))
      throw new SessionError('invalid-request', 'This recipe is managed by the profile. Edit it in Your setup.');
    if (this.trials.get(id)?.run.status === 'running')
      throw new SessionError(
        'busy',
        'Wait for the test run of this recipe to finish.',
      );
    this.params.store.delete(id);
    return this.list();
  }

  async match(
    directory: string,
    signal: AbortSignal,
  ): Promise<WorktreeRecipeMatch> {
    const match = await this.inspect(directory, signal);
    let repositoryScript: WorktreeRecipeMatch['repositoryScript'] = null;
    try {
      repositoryScript = inspectWorktreeSetup(
        this.params.dataDirectory,
        randomUUID(),
        match.directory,
        match.gitDirectory,
      ).script;
    } catch {
      repositoryScript = null;
    }
    return {
      repository: match.recipe?.repository ?? match.candidates[0]!,
      directory: match.directory,
      recipe: match.recipe
        ? {
            ...match.recipe,
            approved: this.params.store.isApproved(
              match.recipe.sha256,
              match.gitDirectory,
            ),
          }
        : null,
      repositoryScript,
      repositoryIncludes: this.hasIncludes(match.directory),
    };
  }

  created(session: Session): void {
    if (this.closing || !session.worktree) return;
    try {
      this.prepare(session);
    } catch {
      return;
    }
  }

  private prepare(session: Session): void {
    const checkout = this.checkout(session.id);
    if (!checkout) return;
    const recipe = this.params.store.forRepository(
      repositoryCandidates(checkout.gitDirectory, checkout.projectDirectory),
    );
    if (!recipe) return;
    const fromProfile = this.params.store.profile.get(recipe.id);
    const ownsDefinition = session.worktree?.profileManaged === true;
    if ((checkout.binding || ownsDefinition) && hasLegacyRecipeCommands(recipe)) return;
    if (ownsDefinition && !fromProfile) return;
    if (fromProfile && !this.params.store.setupProfile()?.declarations.some(
      declaration => declaration.key === fromProfile.declaration && declaration.state !== 'masked',
    )) return;
    const repositoryScript = checkout.binding || fromProfile ? null : this.repositoryScript(session.id, checkout);
    let release: () => void = noop;
    try {
      release = this.params.claim(session.id);
    } catch {
      release = noop;
    }
    const live: Live = {
      run: {
        sessionId: session.id,
        directory: session.directory,
        recipe: snapshotOf(recipe),
        repositoryScript,
        status: 'needs-approval',
        resources: null,
        released: false,
        copied: null,
        steps: [],
        error: null,
        updatedAt: now(),
      },
      controller: new AbortController(),
      release,
      done: null,
    };
    this.live.set(session.id, live);
    if (
      (!checkout.binding || fromProfile && checkout.binding.ownership === 'created') &&
      this.params.store.profile.passes(recipe.id) &&
      this.params.store.isApproved(recipe.sha256, checkout.gitDirectory) &&
      (!repositoryScript || repositoryScript.approved)
    )
      this.start(live);
    else this.persist(live);
  }

  read(sessionId: string): WorktreeRecipeRun | null {
    const run = this.live.get(sessionId)?.run ?? this.params.store.run(sessionId);
    return run ? structuredClone(run) : null;
  }

  async decide(
    input: DecideSessionWorktreeRecipeInput,
  ): Promise<WorktreeRecipeRun | null> {
    const session = this.params.session(input.sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    const live = this.liveRun(input.sessionId);
    if (!live)
      throw new SessionError(
        'not-found',
        'No worktree recipe applies to this session.',
      );
    const { run } = live;
    if (run.recipe.sha256 !== input.sha256)
      throw new SessionError(
        'invalid-request',
        'The recipe changed. Reopen it and review the new version.',
      );
    if (input.decision === 'stop') {
      if (run.status === 'running') {
        live.controller.abort();
        await live.done;
      }
      return this.read(input.sessionId);
    }
    if (run.released || session.worktree?.state !== 'active')
      throw new SessionError(
        'invalid-request',
        'This worktree session is finished.',
      );
    if (run.status === 'running' || run.status === 'ready')
      return this.read(input.sessionId);
    if (input.decision === 'skip') {
      if (run.status !== 'needs-approval') return this.read(input.sessionId);
      run.status = 'skipped';
      run.updatedAt = now();
      live.release();
      live.release = noop;
      this.persist(live);
      return this.read(input.sessionId);
    }
    if (!this.profileRecipeCurrent(run.recipe))
      throw new SessionError('invalid-request', 'Review the current profile recipe before running it.');
    const checkout = this.checkout(session.id);
    if (!checkout)
      throw new SessionError(
        'not-found',
        'The session worktree record is missing.',
      );
    const expectedStatus = run.status;
    if (checkout.binding)
      await this.verifyBoundCheckout(run.directory, checkout, live.controller.signal);
    if (this.live.get(session.id) !== live || run.released || run.status !== expectedStatus)
      return this.read(input.sessionId);
    if (live.release === noop) live.release = this.params.claim(session.id);
    this.params.store.approve(run.recipe.sha256, checkout.gitDirectory);
    live.controller = new AbortController();
    this.start(live);
    return this.read(input.sessionId);
  }

  environment(session: Session): Record<string, string> {
    const id = session.parentId ?? session.id;
    const run = this.live.get(id)?.run ?? this.params.store.run(id);
    if (!run || run.released || !run.resources) return {};
    return recipeVariables(run);
  }

  async finishing(sessionId: string, signal: AbortSignal): Promise<void> {
    const live = this.liveRun(sessionId);
    if (!live || live.run.released) return;
    if (live.run.status === 'running') {
      live.controller.abort();
      await live.done;
    }
    live.release();
    live.release = noop;
    const { run } = live;
    if (run.status === 'needs-approval') run.status = 'skipped';
    if (run.resources) {
      const checkout = this.checkout(sessionId);
      if (
        checkout &&
        hasRecipeCommand(run.recipe.cleanup.command) &&
        this.params.store.isApproved(
          run.recipe.sha256,
          checkout.gitDirectory,
        ) &&
        existsSync(run.directory)
      ) {
        const step = emptyStep('cleanup');
        run.steps = [...run.steps.filter(item => item.kind !== 'cleanup'), step];
        startStep(step);
        this.persist(live);
        endStep(
          step,
          await this.runStage(live, step, 'cleanup', checkout.projectDirectory, signal),
        );
      }
      await removeTempDirectory(
        this.params.dataDirectory,
        sessionId,
        run.resources,
      ).catch(error => {
        run.error = errorText(error, 'The temporary directory remained.');
      });
    }
    run.released = true;
    run.updatedAt = now();
    this.persist(live);
    this.live.delete(sessionId);
  }

  async startTrial(
    input: StartWorktreeRecipeTrialInput,
    signal: AbortSignal,
  ): Promise<WorktreeRecipeRun | null> {
    if (this.closing)
      throw new SessionError('busy', 'The host is shutting down.');
    const recipe = this.params.store.get(input.id);
    if (!recipe)
      throw new SessionError('not-found', 'This recipe no longer exists.');
    const current = this.trials.get(recipe.id);
    if (current?.run.status === 'running') return this.readTrial(recipe.id);
    const match = await this.inspect(input.directory, signal);
    if (!match.candidates.some(item => item.key === recipe.repository.key))
      throw new SessionError(
        'invalid-request',
        `This folder is not a checkout of ${recipe.repository.label}.`,
      );
    const trialId = randomUUID();
    const root = join(realpathSync.native(this.params.dataDirectory), TRIAL_ROOT);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = join(root, trialId.slice(0, 8));
    const added = await runGit({
      args: ['worktree', 'add', '--detach', directory, 'HEAD'],
      cwd: match.directory,
      timeoutMs: GIT_CHANGE_TIMEOUT_MS,
      signal,
    });
    if (added.code !== 0)
      throw new SessionError(
        'unavailable',
        `Git could not create the test worktree. ${added.stderr.trim()}`.slice(
          0,
          worktreeRecipeLimits.error,
        ),
      );
    const live: Live = {
      run: {
        sessionId: null,
        directory,
        recipe: snapshotOf(recipe),
        repositoryScript: null,
        status: 'running',
        resources: null,
        released: false,
        copied: null,
        steps: [emptyStep('copy'), emptyStep('setup'), emptyStep('cleanup')],
        error: null,
        updatedAt: now(),
      },
      controller: new AbortController(),
      release: noop,
      done: null,
    };
    this.trials.set(recipe.id, live);
    live.done = this.executeTrial(live, trialId, match);
    return this.readTrial(recipe.id);
  }

  readTrial(id: string): WorktreeRecipeRun | null {
    const run = this.trials.get(id)?.run;
    return run ? structuredClone(run) : null;
  }

  async stopTrial(id: string): Promise<WorktreeRecipeRun | null> {
    const live = this.trials.get(id);
    if (live?.run.status === 'running') {
      live.controller.abort();
      await live.done;
    }
    return this.readTrial(id);
  }

  async close(): Promise<void> {
    this.closing = true;
    const running = [...this.live.values(), ...this.trials.values()];
    for (const live of running) live.controller.abort();
    await Promise.all(running.map(live => live.done));
  }

  private async inspect(directory: string, signal: AbortSignal) {
    const folder = await resolveFolder(directory, signal);
    const root = await repositoryRoot(folder, signal);
    const gitDirectory = await repositoryGitDirectory(root, signal);
    const candidates = repositoryCandidates(gitDirectory, root);
    return {
      directory: root,
      gitDirectory,
      candidates,
      recipe: this.params.store.forRepository(candidates),
    };
  }

  private hasIncludes(directory: string) {
    try {
      readWorktreeFile(directory, '.worktreeinclude', 64 * 1024);
      return true;
    } catch {
      return false;
    }
  }

  private checkout(sessionId: string): Checkout | undefined {
    const worktree = this.params.session(sessionId)?.worktree;
    if (worktree?.binding)
      return { projectDirectory: worktree.projectDirectory, gitDirectory: worktree.binding.gitDirectory, binding: worktree.binding };
    const record = sessionCheckout(this.params.dataDirectory, sessionId);
    return (
      record && {
        projectDirectory: record.projectDirectory,
        gitDirectory: record.gitDirectory,
      }
    );
  }

  private async verifyBoundCheckout(directory: string, checkout: Checkout, signal: AbortSignal) {
    await readSessionWorktreeStatus({ dataDirectory: this.params.dataDirectory, projectDirectory: checkout.projectDirectory, worktree: directory, binding: checkout.binding, signal });
  }

  private profileRecipeCurrent(recipe: WorktreeRecipeSnapshot) {
    const store = this.params.store;
    return !store.profile.get(recipe.id) ||
      store.profile.passes(recipe.id) && store.get(recipe.id)?.sha256 === recipe.sha256;
  }

  private async verifyDirect(kind: 'setup' | 'cleanup', command: DirectCommand, source: string, signal: AbortSignal) {
    if (command.files.some(file => !isAbsolute(file)) || command.argv.some(argument =>
      /(?:<[A-Za-z][A-Za-z0-9]*>|--?(?:token|api[-_]?key|password|secret|authorization)\b|:\/\/[^/\s]+@)/i.test(argument) ||
      argument && !isAbsolute(argument) && !argument.startsWith('-') && existsSync(resolve(source, argument))
    )) throw new SessionError('invalid-request', 'Use absolute command file paths and fixed arguments without secrets.');
    return inspectDirectCommand(command, source, `worktree recipe ${kind}`, this.params.store.commandKey, signal);
  }

  private async pinStage(kind: 'setup' | 'cleanup', stage: WorktreeRecipeSnapshot['setup'], source: string, signal: AbortSignal) {
    const { command, timeoutSeconds } = stage;
    if (typeof command === 'string') return { command, timeoutSeconds };
    try {
      const verified = await this.verifyChain(kind, command, source, signal);
      return { command, timeoutSeconds, fingerprint: verified.fingerprint };
    } catch (error) {
      throw new SessionError('invalid-request', errorText(error, 'The direct command could not be verified.'));
    }
  }

  private async verifyChain(kind: 'setup' | 'cleanup', command: DirectCommand | DirectCommand[], source: string, signal: AbortSignal) {
    const commands = Array.isArray(command) ? command : [command];
    const reviewed = await Promise.all(commands.map(async definition => ({
      definition,
      verified: await this.verifyDirect(kind, definition, source, signal),
    })));
    const fingerprint = Array.isArray(command)
      ? configurationHash(JSON.stringify(reviewed.map(item => item.verified.fingerprint)))
      : reviewed[0]!.verified.fingerprint;
    return { reviewed, fingerprint };
  }

  private async runStage(live: Live, step: WorktreeRecipeStep, kind: 'setup' | 'cleanup', source: string, signal: AbortSignal): Promise<Partial<WorktreeRecipeStep> & Pick<WorktreeRecipeStep, 'status'>> {
    const { run } = live;
    const { command, timeoutSeconds, fingerprint } = run.recipe[kind];
    const onOutput = (output: string, truncated: boolean) => {
      step.output = output;
      step.truncated = truncated;
      run.updatedAt = now();
    };
    if (!this.profileRecipeCurrent(run.recipe))
      return { status: 'failed', output: 'The profile recipe changed or its approval was revoked.' };
    if (typeof command === 'string')
      return runRecipeCommand({ command: command.trim(), cwd: run.directory, env: commandEnvironment(recipeVariables(run)), timeoutSeconds, signal, onOutput });
    try {
      const approved = await this.verifyChain(kind, command, source, signal);
      if (approved.fingerprint !== fingerprint)
        throw new Error('The direct command or its files changed. Save and review the recipe again.');
      let output = '';
      let truncated = false;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1000)]);
      for (const { definition, verified } of approved.reviewed) {
        deadline.throwIfAborted();
        if (!this.profileRecipeCurrent(run.recipe))
          throw new Error('The profile recipe changed or its approval was revoked.');
        const current = await this.verifyDirect(kind, definition, source, deadline);
        if (current.fingerprint !== verified.fingerprint)
          throw new Error('A command or input changed during the recipe.');
        const result = await runDirectCommand(definition, { ...verified, cwd: run.directory }, {}, deadline, undefined, recipeVariables(run));
        output = [output, redactLogMessage([result.stdout, result.stderr].filter(Boolean).join('\n'))].filter(Boolean).join('\n');
        truncated ||= result.outputTruncated || output.length > worktreeRecipeLimits.output;
        output = output.slice(-worktreeRecipeLimits.output);
        if (result.code !== 0 || result.timedOut || result.outputTruncated)
          return {
            status: result.timedOut || deadline.aborted && !signal.aborted ? 'timed-out' : signal.aborted ? 'stopped' : 'failed',
            exitCode: result.code, output, truncated,
          };
      }
      return { status: 'completed', exitCode: 0, output, truncated };
    } catch (error) {
      return { status: signal.aborted ? 'stopped' : 'failed', exitCode: null, output: errorText(error, 'The direct command could not run.') };
    }
  }

  private repositoryScript(sessionId: string, checkout: Checkout) {
    try {
      return inspectWorktreeSetup(
        this.params.dataDirectory,
        sessionId,
        checkout.projectDirectory,
        checkout.gitDirectory,
      ).script;
    } catch {
      return null;
    }
  }

  private liveRun(sessionId: string): Live | undefined {
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const run = this.params.store.run(sessionId);
    if (!run) return undefined;
    const live: Live = {
      run,
      controller: new AbortController(),
      release: noop,
      done: null,
    };
    this.live.set(sessionId, live);
    return live;
  }

  private persist(live: Live): void {
    live.run.updatedAt = now();
    try {
      this.params.store.saveRun(live.run);
    } catch {
      live.run.error ??= 'The recipe state could not be saved.';
    }
  }

  private recover(): void {
    for (const run of this.params.store.unreleasedRuns()) {
      if (!run.sessionId) continue;
      const session = this.params.session(run.sessionId);
      if (run.status === 'running') {
        run.status = 'interrupted';
        for (const step of run.steps)
          if (step.status === 'running' || step.status === 'pending')
            endStep(step, { status: 'stopped' });
      }
      if (!session || session.worktree?.state !== 'active') {
        run.released = true;
        if (run.resources)
          void removeTempDirectory(
            this.params.dataDirectory,
            run.sessionId,
            run.resources,
          ).catch(() => undefined);
      }
      run.updatedAt = now();
      try {
        this.params.store.saveRun(run);
      } catch {
        continue;
      }
    }
  }

  private takenPorts(): Set<number> {
    const taken = new Set<number>();
    const add = (run: WorktreeRecipeRun) => {
      if (!run.released) for (const port of run.resources?.ports ?? []) taken.add(port);
    };
    for (const live of [...this.live.values(), ...this.trials.values()])
      add(live.run);
    for (const run of this.params.store.unreleasedRuns()) {
      if (!run.sessionId || this.live.has(run.sessionId)) continue;
      if (this.params.session(run.sessionId)?.worktree?.state === 'active')
        add(run);
    }
    return taken;
  }

  private allocate(live: Live, id: string): Promise<void> {
    const next = this.allocation.then(async () => {
      live.run.resources = await createResources(
        this.params.dataDirectory,
        id,
        live.run.recipe,
        this.takenPorts(),
        live.controller.signal,
      );
    });
    this.allocation = next.catch(noop);
    return next;
  }

  private start(live: Live): void {
    const { run } = live;
    run.status = 'running';
    run.error = null;
    run.copied = null;
    run.steps = [
      ...(run.repositoryScript ? [emptyStep('repository-script')] : []),
      emptyStep('copy'),
      emptyStep('setup'),
    ];
    this.persist(live);
    live.done = this.execute(live).finally(() => {
      live.release();
      live.release = noop;
      this.persist(live);
    });
  }

  private async execute(live: Live): Promise<void> {
    const { run } = live;
    const signal = live.controller.signal;
    const sessionId = run.sessionId!;
    const checkout = this.checkout(sessionId);
    try {
      if (!checkout) throw new Error('The session worktree record is missing.');
      if (!this.profileRecipeCurrent(run.recipe))
        throw new Error('The profile recipe changed or its approval was revoked.');
      if (checkout.binding || this.params.store.profile.get(run.recipe.id))
        await this.verifyBoundCheckout(run.directory, checkout, signal);
      if (!run.resources) await this.allocate(live, sessionId);
      this.persist(live);
      const script = run.steps.find(step => step.kind === 'repository-script');
      if (script && run.repositoryScript) {
        startStep(script);
        const result = await executeWorktreeSetup(
          this.params.dataDirectory,
          run.directory,
          checkout.projectDirectory,
          checkout.gitDirectory,
          { sessionId, sha256: run.repositoryScript.sha256, approve: true },
          signal,
        );
        run.repositoryScript = { ...run.repositoryScript, approved: true };
        endStep(script, {
          status: signal.aborted ? 'stopped' : result.status,
          exitCode: result.exitCode,
          output: [result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n')
            .slice(-worktreeRecipeLimits.output),
          truncated: result.truncated,
        });
        this.persist(live);
        if (script.status !== 'completed') return this.conclude(live, script);
      }
      await this.copyAndSetup(live, checkout.projectDirectory);
    } catch (error) {
      this.fail(live, error);
    }
  }

  private async copyAndSetup(live: Live, source: string): Promise<void> {
    const { run } = live;
    const signal = live.controller.signal;
    const copy = run.steps.find(step => step.kind === 'copy')!;
    startStep(copy);
    run.copied = await copyRecipeFiles(
      this.params.dataDirectory,
      source,
      run.directory,
      run.recipe,
      signal,
    );
    endStep(copy, {
      status: 'completed',
      output: run.recipe.copy.patterns.length
        ? `Copied ${run.copied.copied} ${run.copied.copied === 1 ? 'file' : 'files'} (${formatBytes(run.copied.bytes)}), skipped ${run.copied.skipped}${run.copied.incomplete ? '; the file list was cut short' : ''}.`
        : 'No files to copy.',
    });
    this.persist(live);
    const setup = run.steps.find(step => step.kind === 'setup')!;
    if (!hasRecipeCommand(run.recipe.setup.command)) {
      endStep(setup, { status: 'skipped' });
      return this.conclude(live, setup);
    }
    startStep(setup);
    this.persist(live);
    endStep(
      setup,
      await this.runStage(live, setup, 'setup', source, signal),
    );
    this.conclude(live, setup);
  }

  private conclude(live: Live, last: WorktreeRecipeStep): void {
    const { run } = live;
    run.status = live.controller.signal.aborted
      ? 'stopped'
      : last.status === 'completed' || last.status === 'skipped'
        ? 'ready'
        : 'failed';
    if (run.status === 'failed' && last.status === 'timed-out')
      run.error = 'The command did not finish in time and was stopped.';
    for (const step of run.steps)
      if (step.status === 'pending') step.status = 'skipped';
  }

  private fail(live: Live, error: unknown): void {
    const { run } = live;
    run.status = live.controller.signal.aborted ? 'stopped' : 'failed';
    run.error = errorText(error, 'The recipe could not run.');
    for (const step of run.steps)
      if (step.status === 'running')
        endStep(step, {
          status: live.controller.signal.aborted ? 'stopped' : 'failed',
        });
      else if (step.status === 'pending') step.status = 'skipped';
  }

  private async executeTrial(
    live: Live,
    trialId: string,
    match: { directory: string },
  ): Promise<void> {
    const { run } = live;
    try {
      await this.allocate(live, trialId);
      await this.copyAndSetup(live, match.directory);
    } catch (error) {
      this.fail(live, error);
    }
    const cleanup = run.steps.find(step => step.kind === 'cleanup')!;
    try {
      if (hasRecipeCommand(run.recipe.cleanup.command) && run.resources) {
        startStep(cleanup);
        endStep(
          cleanup,
          await this.runStage(live, cleanup, 'cleanup', match.directory, new AbortController().signal),
        );
        if (run.status === 'ready' && cleanup.status !== 'completed')
          run.status = 'failed';
      } else endStep(cleanup, { status: 'skipped' });
      if (run.resources)
        await removeTempDirectory(
          this.params.dataDirectory,
          trialId,
          run.resources,
        );
    } catch (error) {
      run.error ??= errorText(error, 'Cleanup could not finish.');
    }
    const removed = await runGit({
      args: ['worktree', 'remove', '--force', run.directory],
      cwd: match.directory,
      timeoutMs: GIT_CHANGE_TIMEOUT_MS,
      signal: new AbortController().signal,
    }).catch(() => null);
    if (removed?.code !== 0)
      run.error ??= `The test worktree ${run.directory} could not be removed.`;
    run.released = true;
    run.updatedAt = now();
  }
}
