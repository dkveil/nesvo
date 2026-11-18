import { McpPolicy } from './mcp/service';
import { sweepClaudeRunConfigs } from './mcp/claude-config-file';
import {
  HOST_CONTRACT_REVISION,
  hostHealthSchema,
  hostCapabilitySchema,
  hostRequestSchema,
  claudeStatusSchema,
  codexStatusSchema,
  isWorkflowMethod,
  toSessionWindow,
  type DefinitionCatalog,
  type DefinitionWriteResult,
  type DesktopEvent,
  type HostMessage,
  type HostRequest,
  type HostResponse,
  type Session,
  type SessionWindow,
  type SkillCatalog,
} from '@nesvo/contracts';
import { Effect } from 'effect';
import { backupDatabaseNow, openDatabase, ownDataDirectory } from './database';
import { CostStore } from './cost-store';
import { inspectClaude } from './providers/claude';
import { inspectCodex } from './providers/codex';
import { ProviderProfiles, profileEnvironment } from './providers/profiles';
import { SessionService, SessionError } from './sessions/service';
import { AttachmentError } from './sessions/attachments';
import { SessionStore } from './sessions/store';
import { ConversationImport } from './sessions/conversation-import';
import { HistorySearch } from './sessions/history-search';
import { TranscriptIndex } from './sessions/transcript-index';
import { SessionGroupStore } from './sessions/group-store';
import { SessionDeletions } from './sessions/deletion';
import { SessionHousekeeping } from './sessions/housekeeping';
import { ReviewStore } from './review/store';
import { PullRequestAutoLink } from './pull-request-auto-link';
import { PullRequests } from './pull-requests';
import { TrackedRepositories } from './tracked-repositories';
import { PullRequestError } from './process/github-cli';
import { CodeReviewStore } from './code-review/store';
import { CodeReviewError, CodeReviews } from './code-review/service';
import { WorkspaceError, WorkspaceFiles } from './workspace/files';
import { FolderError, resolveFolder } from './workspace/folder';
import { GitBranchError, readGitBranch } from './workspace/git-branch';
import {
  SessionChangeError,
  SessionChangeReader,
} from './workspace/session-changes';
import { WorkspaceIsolationError } from './workspace/isolation';
import {
  discoverDirectorySkills,
  discoverSessionSkills,
} from './skills/service';
import { ProviderUsageService } from './providers/usage-service';
import { WorkflowRunStore } from './workflows/store';
import {
  DefinitionError,
  inside as insideFolder,
  loadCatalog,
  loadSpec,
} from './workflows/definitions';
import {
  AssistantChangeError,
  AssistantChanges,
  automationsIn,
} from './workflows/assistant-changes';
import { AssistantChangeStore } from './workflows/assistant-change-store';
import {
  WorkflowAssistant,
  WorkflowAssistantError,
} from './workflows/assistant';
import { EvidenceError, EvidenceStore } from './workflows/evidence';
import { probeExecutor } from './workflows/steps/probe';
import { createWaitCiExecutor } from './workflows/steps/wait-ci';
import { WorkflowRunError, WorkflowRunner } from './workflows/runner';
import { WorkflowGates } from './workflows/gates';
import { actionExecutor } from './workflows/steps/action';
import { createAgentExecutor } from './workflows/steps/agent';
import { commandExecutor } from './workflows/steps/command';
import { createHumanExecutor } from './workflows/steps/human';
import {
  WorkflowTasks,
  SpecSnapshots,
  bindRunEvents,
  createSessionAuthor,
  runEnvironment,
} from './workflows/tasks';
import { deleteDefinition, saveDefinition } from './workflows/writer';
import { ScheduledJobStore } from './scheduled-jobs/store';
import {
  ScheduledJobError,
  ScheduledJobService,
} from './scheduled-jobs/service';
import { SessionLauncher } from './scheduled-jobs/launcher';

const OPERATOR_ACTIVITY_METHODS = new Set<HostRequest['method']>([
  'act-on-pull-request',
  'link-session-pull-request',
  'add-tracked-repository',
  'remove-tracked-repository',
  'reorder-tracked-repositories',
  'start-pull-request-review',
  'publish-pull-request-review',
  'create-session',
  'adopt-conversation',
  'finish-session-worktree',
  'run-session-worktree-setup',
  'remove-orphaned-session-worktree',
  'fork-session',
  'restart-session',
  'compact-session',
  'send-message',
  'queue-message',
  'assign-session-workflow',
  'create-session-group',
  'update-session-group',
  'move-session-group',
  'delete-session-group',
  'move-session',
  'rename-session',
  'set-session-pinned',
  'set-session-terminal',
  'set-session-archived',
  'delete-session',
  'restore-session',
  'set-session-mcp',
  'trust-repository-mcp',
  'cancel-queued',
  'start-queued',
  'stop-run',
  'respond-approval',
  'decide-delegation',
  'decide-worker-plan',
  'decide-review',
  'start-workflow-task',
  'run-workflow-steps',
  'decide-workflow-gate',
  'skip-workflow-step',
  'resume-workflow-run',
  'stop-workflow-run',
  'save-workflow-definition',
  'delete-workflow-definition',
  'remove-workflow-worktree',
  'workflow-assistant-send',
  'workflow-assistant-undo',
  'resolve-workflow-step',
]);
const SERVED_WORKFLOW_METHODS = new Set<HostRequest['method']>([
  'list-workflow-definitions',
  'validate-workflow-definitions',
  'start-workflow-task',
  'run-workflow-steps',
  'resume-workflow-run',
  'decide-workflow-gate',
  'skip-workflow-step',
  'resolve-workflow-step',
  'list-workflow-runs',
  'get-workflow-run',
  'stop-workflow-run',
  'read-workflow-evidence',
  'save-workflow-definition',
  'delete-workflow-definition',
  'workflow-assistant-send',
  'workflow-assistant-undo',
  'workflow-assistant-changes',
  'assign-session-workflow',
]);
const CONCURRENT_DEFINITION_WRITES = 4;
const ADVERTISED_CAPABILITIES = hostCapabilitySchema.options;

const worktreeFailure = (error: unknown, message: string) => ({
  code:
    error instanceof SessionError
      ? error.code
      : error instanceof FolderError
        ? ('invalid-directory' as const)
        : error instanceof WorkspaceIsolationError
          ? ('invalid-request' as const)
          : ('unavailable' as const),
  message:
    error instanceof SessionError ||
    error instanceof FolderError ||
    error instanceof WorkspaceIsolationError
      ? error.message
      : message,
});

const definitionErrorCode = (error: unknown) => {
  if (!(error instanceof DefinitionError)) return 'unavailable' as const;
  if (error.kind === 'not-found') return 'invalid-directory' as const;
  if (error.kind === 'invalid') return 'invalid-request' as const;
  if (error.kind === 'busy') return 'busy' as const;
  return 'unavailable' as const;
};

type HostTransport = {
  directory: string;
  incoming: AsyncIterable<unknown>;
  send: (response: HostMessage) => Promise<void>;
};

type HostReply =
  | Exclude<HostResponse, { type: 'session' }>
  | { type: 'session'; id: string; session: Session | SessionWindow };

const toHostMessage = (message: HostReply | DesktopEvent): HostMessage => {
  if (message.type !== 'session') return message;
  const { session } = message;
  return {
    ...message,
    session: 'messageCount' in session ? session : toSessionWindow(session),
  };
};

export const serveHost = ({
  directory,
  incoming,
  send: deliver,
}: HostTransport) =>
  Effect.scoped(
    Effect.gen(function* () {
      const send = (message: HostReply | DesktopEvent) =>
        deliver(toHostMessage(message));
      yield* ownDataDirectory(directory);
      yield* Effect.try(() => sweepClaudeRunConfigs(directory));
      const database = yield* openDatabase(directory);
      const backupDatabase = () => {
        try {
          return backupDatabaseNow(database, directory);
        } catch (error) {
          throw new SessionError(
            'unavailable',
            `The backup could not be written. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      const history = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const index = new HistorySearch(database);
          index.start();
          return index;
        }),
        index => Effect.sync(() => index.close()),
      );
      const profiles = new ProviderProfiles(database);
      const store = new SessionStore(database);
      const groupStore = new SessionGroupStore(database);
      const costs = new CostStore(database);
      const scheduledJobStore = new ScheduledJobStore(database);
      const workflowRunStore = new WorkflowRunStore(database);
      const reviewStore = new ReviewStore(database);
      const workspace = new WorkspaceFiles(id => store.get(id));
      const sessionChanges = new SessionChangeReader(id => store.get(id));
      let outgoing = Promise.resolve();
      const emit = (message: DesktopEvent) => {
        outgoing = outgoing.then(() => send(message)).catch(() => undefined);
      };
      let wakeIdleRuns = () => {};
      let observeAssistant: (session: Session) => void = () => {};
      const emitSessionEvent = (
        message: DesktopEvent,
        session: Session | null,
      ) => {
        emit(message);
        if (!session) return;
        wakeIdleRuns();
        observeAssistant(session);
      };
      const sessions = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new SessionService(
              store,
              directory,
              emitSessionEvent,
              reviewStore,
              () => {
                const at = new Date().toISOString();
                scheduledJobStore.interruptActiveRuns(at);
                workflowRunStore.interruptActiveRuns(at);
              },
              {
                profiles,
                mcp: new McpPolicy(database),
                checkCostBudgets: (session, now) => costs.check(session, now),
                environment: session => {
                  const run = session.workflowRunId
                    ? workflowRunStore.getRun(session.workflowRunId)
                    : undefined;
                  return run ? runEnvironment(run) : undefined;
                },
                isKnownGroup: groupId => !!groupStore.get(groupId),
                isHeldByWorkflow: review => {
                  const runId = store.get(review.sessionId)?.workflowRunId;
                  return (
                    workflowRunStore.isGatePending(review.id, review.version) ||
                    (!!runId && workflowRunStore.isRunInProgress(runId))
                  );
                },
              },
            ),
        ),
        service =>
          Effect.promise(async () => {
            await service.close();
            await outgoing;
          }),
      );
      const probes = yield* Effect.acquireRelease(
        Effect.sync(() => ({
          controller: new AbortController(),
          pending: new Set<Promise<void>>(),
        })),
        state =>
          Effect.promise(async () => {
            await sessions.close();
            state.controller.abort();
            await Promise.all(state.pending);
          }),
      );
      const housekeeping = new SessionHousekeeping(sessions, groupStore, emit);
      const deletions = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const service = new SessionDeletions(
            database,
            sessions,
            reviewStore,
            emit,
          );
          service.start();
          return service;
        }),
        service => Effect.sync(() => service.close()),
      );
      const pullRequests = new PullRequests(
        probes.controller.signal,
        id => store.get(id),
        (id, run) =>
          sessions
            .withPullRequestCheckout(id, run)
            .finally(() => wakeIdleRuns()),
      );
      const trackedRepositories = new TrackedRepositories({
        database,
        pullRequests,
        sessions: () => store.listSummaries(),
        signal: probes.controller.signal,
      });
      const codeReviews = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new CodeReviews(
              new CodeReviewStore(database),
              sessions,
              pullRequests,
              emit,
            ),
        ),
        service => Effect.promise(() => service.close()),
      );
      const autoLink = new PullRequestAutoLink({
        session: id => store.get(id),
        repository: id => pullRequests.sessionRepository(id),
        branchPullRequest: id => pullRequests.find(id),
        link: (id, reference) => sessions.autoLinkPullRequest(id, reference),
      });
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          sessions.onRunFinished(finished => void autoLink.consider(finished)),
        ),
        release => Effect.sync(() => release()),
      );
      const usage = new ProviderUsageService();
      const evidence = new EvidenceStore(directory, id =>
        workflowRunStore.getStep(id),
      );
      const snapshots = new SpecSnapshots(directory);
      const workflows = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const runner = new WorkflowRunner({
            store: workflowRunStore,
            emit,
            evidence,
            stepExecutors: {
              command: commandExecutor,
              probe: probeExecutor,
              action: actionExecutor,
              'wait-ci': createWaitCiExecutor({
                read: (target, cwd, signal) =>
                  pullRequests.workflowChecks(target, cwd, signal),
                linked: id => store.get(id)?.pullRequest ?? null,
              }),
              human: createHumanExecutor({
                latest: sessionId => reviewStore.latest(sessionId),
              }),
              agent: createAgentExecutor({
                sessions,
                usage,
                spec: async (run, signal) => {
                  const snapshot = snapshots.read(run.id);
                  if (snapshot !== null) return snapshot;
                  const loaded = await loadSpec(
                    run.specPath,
                    run.directory,
                    signal,
                  );
                  return loaded.source.contentHash === run.specHash
                    ? loaded.spec.body
                    : null;
                },
              }),
            },
            author: createSessionAuthor({
              sessions,
              store: workflowRunStore,
              snapshots,
            }),
          });
          const events = bindRunEvents(sessions, runner);
          wakeIdleRuns = events.idle;
          void runner.recover();
          return { runner, events };
        }),
        ({ runner, events }) =>
          Effect.promise(async () => {
            events.release();
            wakeIdleRuns = () => {};
            await runner.close();
          }),
      ).pipe(Effect.map(({ runner }) => runner));
      const gates = new WorkflowGates({
        store: workflowRunStore,
        runner: workflows,
        reviews: {
          decide: (input, record) => sessions.decideGateReview(input, record),
        },
        emit,
      });
      const tasks = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WorkflowTasks({
              store: workflowRunStore,
              runner: workflows,
              sessions,
              snapshots,
              dataDirectory: directory,
              emit,
            }),
        ),
        service => Effect.promise(() => service.close()),
      );
      const scheduledJobs = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const service = new ScheduledJobService(
            scheduledJobStore,
            sessions,
            new SessionLauncher(
              sessions,
              usage,
              undefined,
              undefined,
              {
                start: (input, signal) => tasks.start(input, signal),
                getRun: id => workflowRunStore.getRun(id),
                stop: id => workflows.stop(id),
              },
              undefined,
              {
                start: (job, runId) =>
                  codeReviews.startForAutomation(job, runId),
              },
            ),
            emit,
          );
          service.start();
          return service;
        }),
        service => Effect.promise(() => service.close()),
      );
      const activeRuns = (target: {
        scope: string;
        name: string;
        projectRoot: string;
      }) =>
        workflowRunStore
          .activeRunsForWorkflow(target.name, null)
          .filter(
            run =>
              target.scope === 'global' ||
              [run.projectRoot, run.directory].some(path =>
                insideFolder(target.projectRoot, path),
              ),
          )
          .map(run => run.id);
      const assistantChanges = new AssistantChanges({
        store: new AssistantChangeStore(database),
        definitions: {
          save: (input, options) =>
            saveDefinition(
              input,
              probes.controller.signal,
              activeRuns,
              options,
            ),
          remove: (input, options) =>
            deleteDefinition(
              input,
              probes.controller.signal,
              activeRuns,
              options,
            ),
        },
        automations: {
          list: () => scheduledJobs.list(),
          save: input => scheduledJobs.save(input),
          delete: input => scheduledJobs.delete(input),
        },
        emit,
      });
      const assistant = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WorkflowAssistant({
              sessions,
              findSession: id => store.get(id),
              definitions: { loadCatalog },
              changes: assistantChanges,
              automations: directory =>
                automationsIn(scheduledJobs.list(), directory),
              emit,
              signal: probes.controller.signal,
            }),
        ),
        service => Effect.promise(() => service.close()),
      );
      observeAssistant = session => assistant.observe(session);
      let evidenceRequests = 0;
      const conversationImport = new ConversationImport(
        store,
        sessions,
        probes.controller.signal,
        profiles,
      );
      const transcriptIndex = new TranscriptIndex(
        database,
        store,
        probes.controller.signal,
      );
      let conversationRequests = 0;
      let workspaceRequests = 0;
      let worktreeRequests = 0;
      let skillRequests = 0;
      let mcpRequests = 0;
      let definitionRequests = 0;
      let definitionWrites = 0;
      const closeUsageAndConsumers = async () => {
        const usageClosed = usage.close();
        try {
          await Promise.all([scheduledJobs.close(), workflows.close()]);
        } finally {
          await usageClosed;
        }
      };
      yield* Effect.addFinalizer(() => Effect.promise(closeUsageAndConsumers));
      const iterator = yield* Effect.acquireRelease(
        Effect.sync(() => incoming[Symbol.asyncIterator]()),
        iterator =>
          Effect.promise(async () => {
            await iterator.return?.();
          }),
      );
      while (true) {
        const item = yield* Effect.tryPromise(() => iterator.next());
        if (item.done) return;
        const parsed = hostRequestSchema.safeParse(item.value);
        if (!parsed.success) {
          yield* Effect.tryPromise(() =>
            send({ type: 'error', id: null, code: 'invalid-request' }),
          );
          continue;
        }
        const request = parsed.data;
        if (OPERATOR_ACTIVITY_METHODS.has(request.method))
          sessions.recordOperatorActivity();
        const unavailable =
          isWorkflowMethod(request.method) &&
          !SERVED_WORKFLOW_METHODS.has(request.method)
            ? 'Workflows are not available on this host yet.'
            : null;
        if (unavailable) {
          yield* Effect.tryPromise(() =>
            send({
              type: 'error',
              id: request.id,
              code: 'unavailable',
              message: unavailable,
            }),
          );
          continue;
        }
        if (request.method === 'shutdown') {
          yield* Effect.promise(closeUsageAndConsumers);
          yield* Effect.promise(() => sessions.close());
          probes.controller.abort();
          yield* Effect.promise(() => Promise.all(probes.pending));
          yield* Effect.promise(() => outgoing);
          yield* Effect.tryPromise(() =>
            send({ type: 'shutdown', id: request.id }),
          );
          return;
        }
        if (
          request.method === 'claude-status' ||
          request.method === 'codex-status'
        ) {
          const signal = probes.controller.signal;
          const provider =
            request.method === 'claude-status' ? 'Claude Code' : 'Codex';
          const inspection = profiles
            .directory(provider, request.input?.profileId, signal)
            .then(async directory => {
              const environment = profileEnvironment(provider, directory);
              return request.method === 'claude-status'
                ? inspectClaude(signal, environment)
                : inspectCodex(signal, environment);
            })
            .then(status =>
              send(
                request.method === 'claude-status'
                  ? {
                      type: 'claude-status',
                      id: request.id,
                      status: claudeStatusSchema.parse(status),
                    }
                  : {
                      type: 'codex-status',
                      id: request.id,
                      status: codexStatusSchema.parse(status),
                    },
              ),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError ? error.code : 'unavailable',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'The provider could not be checked. Try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(inspection);
          void inspection.finally(() => probes.pending.delete(inspection));
          continue;
        }
        if (request.method === 'create-provider-profile') {
          const pending = profiles
            .create(request.input, probes.controller.signal)
            .then(profiles =>
              send({ type: 'provider-profiles', id: request.id, profiles }),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError ? error.code : 'unavailable',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'The account could not be added.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(pending);
          void pending.finally(() => probes.pending.delete(pending));
          continue;
        }
        if (request.method === 'provider-usage') {
          const { provider, profileId } = request.input;
          const inspection = profiles
            .directory(provider, profileId, probes.controller.signal)
            .then(directory =>
              usage.read(
                request.input,
                profileEnvironment(provider, directory),
              ),
            )
            .then(usage =>
              send({ type: 'provider-usage', id: request.id, usage }),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError ? error.code : 'unavailable',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'Account limits could not be read.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(inspection);
          void inspection.finally(() => probes.pending.delete(inspection));
          continue;
        }
        if (
          (request.method === 'create-session' &&
            (request.input.profileId ||
              request.input.effort ||
              request.input.isolation)) ||
          request.method === 'read-session-worktree' ||
          request.method === 'finish-session-worktree' ||
          request.method === 'read-session-worktree-setup' ||
          request.method === 'run-session-worktree-setup' ||
          request.method === 'list-orphaned-session-worktrees' ||
          request.method === 'remove-orphaned-session-worktree'
        ) {
          const worktree =
            request.method !== 'create-session' || !!request.input.isolation;
          if (worktree && worktreeRequests >= 4) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'busy',
                message: 'Worktree operations are busy. Try again shortly.',
              }),
            );
            continue;
          }
          if (worktree) worktreeRequests++;
          const signal = probes.controller.signal;
          const operation = async (): Promise<HostReply> => {
            if (request.method === 'read-session-worktree-setup')
              return {
                type: 'session-worktree-setup',
                id: request.id,
                setup: await sessions.readWorktreeSetup(request.input, signal),
              };
            if (request.method === 'run-session-worktree-setup')
              return {
                type: 'session-worktree-setup-result',
                id: request.id,
                result: await sessions.runWorktreeSetup(request.input, signal),
              };
            if (request.method === 'list-orphaned-session-worktrees')
              return {
                type: 'orphaned-session-worktrees',
                id: request.id,
                worktrees: sessions.listOrphanedWorktrees(),
              };
            if (request.method === 'remove-orphaned-session-worktree')
              return {
                type: 'orphaned-session-worktree-removal',
                id: request.id,
                removal: await sessions.removeOrphanedWorktree(
                  request.input,
                  signal,
                ),
              };
            if (request.method === 'read-session-worktree')
              return {
                type: 'session-worktree-status',
                id: request.id,
                worktree: await sessions.readWorktree(request.input, signal),
              };
            const session =
              request.method === 'finish-session-worktree'
                ? await sessions.finishWorktree(request.input, signal)
                : await sessions.createWithEffort(request.input, signal);
            return { type: 'session', id: request.id, session };
          };
          const pending = operation()
            .then(send)
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                ...worktreeFailure(
                  error,
                  worktree
                    ? 'The worktree operation could not be completed. Refresh the session and try again.'
                    : 'The session could not be created. Refresh the provider and try again.',
                ),
              }),
            )
            .catch(() => undefined);
          probes.pending.add(pending);
          void pending.finally(() => {
            if (worktree) worktreeRequests--;
            probes.pending.delete(pending);
          });
          continue;
        }
        if (request.method === 'set-session-mcp') {
          yield* Effect.tryPromise(() =>
            send({
              type: 'error',
              id: request.id,
              code: 'invalid-request',
              message:
                'MCP servers and hooks are managed in the provider configuration.',
            }),
          );
          continue;
        }
        if (request.method === 'search-transcripts') {
          const pending = transcriptIndex
            .search(request.input)
            .then(search =>
              send({ type: 'transcript-search', id: request.id, search }),
            )
            .catch(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'unavailable',
                message: 'CLI transcripts could not be searched. Try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(pending);
          void pending.finally(() => probes.pending.delete(pending));
          continue;
        }
        if (
          request.method === 'list-conversations' ||
          request.method === 'adopt-conversation'
        ) {
          if (conversationRequests >= 2) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'busy',
                message: 'Conversation import is busy. Try again shortly.',
              }),
            );
            continue;
          }
          conversationRequests++;
          const operation = async (): Promise<HostReply> =>
            request.method === 'list-conversations'
              ? {
                  type: 'conversation-import-catalog',
                  id: request.id,
                  catalog: await conversationImport.list(request.input),
                }
              : {
                  type: 'session',
                  id: request.id,
                  session: await conversationImport.adopt(request.input),
                };
          const pending = operation()
            .then(send)
            .catch(error => {
              const known =
                error instanceof SessionError || error instanceof FolderError;
              return send({
                type: 'error',
                id: request.id,
                code: known ? error.code : 'unavailable',
                message: known
                  ? error.message
                  : 'Conversation import could not be completed. Try again.',
              });
            })
            .catch(() => undefined)
            .finally(() => {
              conversationRequests--;
              probes.pending.delete(pending);
            });
          probes.pending.add(pending);
          continue;
        }
        if (
          request.method === 'list-mcp-servers' ||
          request.method === 'trust-repository-mcp'
        ) {
          const input = request.input;
          const session =
            'sessionId' in input ? store.get(input.sessionId) : undefined;
          const missing = 'sessionId' in input && !session;
          if (missing || mcpRequests >= 2) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: missing ? 'not-found' : 'busy',
                message: missing
                  ? 'Session not found.'
                  : 'MCP discovery is busy. Try again shortly.',
              }),
            );
            continue;
          }
          let target: {
            provider: Session['provider'];
            directory: string;
            profileId?: string | null;
          };
          try {
            target = session
              ? {
                  provider: session.provider,
                  profileId: session.profileId,
                  directory: session.directory,
                }
              : {
                  provider:
                    'provider' in input ? input.provider : 'Claude Code',
                  profileId: 'profileId' in input ? input.profileId : undefined,
                  directory: sessions.draftDirectory(
                    'directory' in input ? input.directory : '',
                  ),
                };
          } catch (error) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError
                    ? error.code
                    : 'invalid-directory',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'The folder cannot be accessed.',
              }),
            );
            continue;
          }
          mcpRequests++;
          const discovery = sessions
            .mcpServers(
              target.provider,
              target.directory,
              probes.controller.signal,
              target.profileId,
              request.method === 'trust-repository-mcp'
                ? request.input.fingerprint
                : undefined,
            )
            .then(list => send({ type: 'mcp-servers', id: request.id, list }))
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError ? error.code : 'unavailable',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'MCP configuration could not be read on this computer. Try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(discovery);
          void discovery.finally(() => {
            mcpRequests--;
            probes.pending.delete(discovery);
          });
          continue;
        }
        if (request.method === 'fork-session') {
          const fork = sessions
            .fork(request.input, probes.controller.signal)
            .then(session => send({ type: 'session', id: request.id, session }))
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError ? error.code : 'unavailable',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'The session could not be forked.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(fork);
          void fork.finally(() => probes.pending.delete(fork));
          continue;
        }
        if (request.method === 'assign-session-workflow') {
          const assignment = sessions
            .assignWorkflow(request.input, probes.controller.signal)
            .then(session => send({ type: 'session', id: request.id, session }))
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError ? error.code : 'unavailable',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'The workflow could not be assigned. Refresh the session and try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(assignment);
          void assignment.finally(() => probes.pending.delete(assignment));
          continue;
        }
        if (request.method === 'decide-review') {
          const decision = sessions
            .decideReview(request.input)
            .then(review => send({ type: 'review', id: request.id, review }))
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError ? error.code : 'unavailable',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'Your decision could not be saved. Refresh results and try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(decision);
          void decision.finally(() => probes.pending.delete(decision));
          continue;
        }
        if (request.method === 'decide-workflow-gate') {
          const decision = gates
            .decide(request.input)
            .then(run => send({ type: 'workflow-run', id: request.id, run }))
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof WorkflowRunError ||
                  error instanceof SessionError
                    ? error.code
                    : 'unavailable',
                message:
                  error instanceof WorkflowRunError ||
                  error instanceof SessionError
                    ? error.message
                    : 'Your decision could not be saved. Refresh the run and try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(decision);
          void decision.finally(() => probes.pending.delete(decision));
          continue;
        }
        if (
          request.method === 'list-workflow-definitions' ||
          request.method === 'validate-workflow-definitions'
        ) {
          if (definitionRequests >= 2) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'busy',
                message:
                  'Workflow definitions are already being read. Try again shortly.',
              }),
            );
            continue;
          }
          let loading: Promise<DefinitionCatalog>;
          try {
            loading = loadCatalog(
              sessions.draftDirectory(request.input.directory),
              probes.controller.signal,
            );
          } catch (error) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError
                    ? error.code
                    : 'invalid-directory',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'The folder cannot be accessed.',
              }),
            );
            continue;
          }
          definitionRequests++;
          const inspection = loading
            .then(catalog =>
              send({ type: 'workflow-definitions', id: request.id, catalog }),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof DefinitionError && error.kind === 'not-found'
                    ? 'invalid-directory'
                    : 'unavailable',
                message:
                  error instanceof DefinitionError
                    ? error.message
                    : 'Workflow definitions could not be read. Verify the folder and try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(inspection);
          void inspection.finally(() => {
            definitionRequests--;
            probes.pending.delete(inspection);
          });
          continue;
        }
        if (
          request.method === 'run-workflow-steps' ||
          request.method === 'start-workflow-task'
        ) {
          const start = (
            request.method === 'start-workflow-task'
              ? tasks.start(request.input, probes.controller.signal)
              : workflows.startManualRun(
                  request.input,
                  probes.controller.signal,
                )
          )
            .then(run => send({ type: 'workflow-run', id: request.id, run }))
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof WorkflowRunError ||
                  error instanceof SessionError
                    ? error.code
                    : 'unavailable',
                message:
                  error instanceof WorkflowRunError ||
                  error instanceof SessionError
                    ? error.message
                    : 'The workflow run could not start. Try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(start);
          void start.finally(() => probes.pending.delete(start));
          continue;
        }
        if (request.method === 'workflow-assistant-send') {
          const turn = assistant
            .send(request.input)
            .then(turn =>
              send({ type: 'workflow-assistant-turn', id: request.id, turn }),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof WorkflowAssistantError ||
                  error instanceof SessionError
                    ? error.code
                    : 'unavailable',
                message:
                  error instanceof WorkflowAssistantError ||
                  error instanceof SessionError
                    ? error.message
                    : 'The workflow assistant could not start. Try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(turn);
          void turn.finally(() => probes.pending.delete(turn));
          continue;
        }
        if (request.method === 'workflow-assistant-undo') {
          const undo = assistantChanges
            .undo(request.input)
            .then(result =>
              send({ type: 'workflow-assistant-undo', id: request.id, result }),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof AssistantChangeError
                    ? error.code
                    : 'unavailable',
                message:
                  error instanceof AssistantChangeError
                    ? error.message
                    : 'The change could not be undone. Try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(undo);
          void undo.finally(() => probes.pending.delete(undo));
          continue;
        }
        if (request.method === 'workflow-assistant-changes') {
          let response: HostMessage;
          try {
            response = {
              type: 'workflow-assistant-changes',
              id: request.id,
              history: assistantChanges.history(request.input.conversationId),
            };
          } catch {
            response = {
              type: 'error',
              id: request.id,
              code: 'unavailable',
              message: 'The change history could not be read. Try again.',
            };
          }
          yield* Effect.tryPromise(() => send(response));
          continue;
        }
        if (request.method === 'read-workflow-evidence') {
          if (evidenceRequests >= 8) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'busy',
                message: 'Too many evidence requests. Try again shortly.',
              }),
            );
            continue;
          }
          evidenceRequests++;
          const reading = evidence
            .read(request.input.runId, request.input.stepId, request.input.path)
            .then(item =>
              send({
                type: 'workflow-evidence',
                id: request.id,
                evidence: item,
              }),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof EvidenceError ? error.code : 'unavailable',
                message:
                  error instanceof EvidenceError
                    ? error.message
                    : 'The evidence could not be read. Try again.',
              }),
            )
            .catch(() => undefined)
            .finally(() => {
              evidenceRequests--;
              probes.pending.delete(reading);
            });
          probes.pending.add(reading);
          continue;
        }
        if (
          request.method === 'save-workflow-definition' ||
          request.method === 'delete-workflow-definition'
        ) {
          if (definitionWrites >= CONCURRENT_DEFINITION_WRITES) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'busy',
                message:
                  'Workflow definitions are already being written. Try again shortly.',
              }),
            );
            continue;
          }
          let directory: string;
          try {
            directory = sessions.draftDirectory(request.input.directory);
          } catch (error) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof SessionError
                    ? error.code
                    : 'invalid-directory',
                message:
                  error instanceof SessionError
                    ? error.message
                    : 'The folder cannot be accessed.',
              }),
            );
            continue;
          }
          definitionWrites++;
          const writing: Promise<DefinitionWriteResult> =
            request.method === 'save-workflow-definition'
              ? saveDefinition(
                  { ...request.input, directory },
                  probes.controller.signal,
                  activeRuns,
                )
              : deleteDefinition(
                  { ...request.input, directory },
                  probes.controller.signal,
                  activeRuns,
                );
          const change = writing
            .then(result =>
              send(
                'type' in result
                  ? { ...result, id: request.id }
                  : {
                      type: 'workflow-definitions',
                      id: request.id,
                      catalog: result,
                    },
              ),
            )
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code: definitionErrorCode(error),
                message:
                  error instanceof DefinitionError
                    ? error.message
                    : 'The definition could not be written. Verify the folder and try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(change);
          void change.finally(() => {
            definitionWrites--;
            probes.pending.delete(change);
          });
          continue;
        }
        if (request.method === 'discover-skills') {
          const input = request.input;
          const session =
            'sessionId' in input ? store.get(input.sessionId) : undefined;
          const missing = 'sessionId' in input && !session;
          if (missing || skillRequests >= 2) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: missing ? 'not-found' : 'busy',
                message: missing
                  ? 'Session not found.'
                  : 'Skill discovery is busy. Try again shortly.',
              }),
            );
            continue;
          }
          let discovery: Promise<SkillCatalog>;
          const signal = probes.controller.signal;
          if (session)
            discovery = profiles
              .directory(session.provider, session.profileId, signal)
              .then(directory =>
                discoverSessionSkills(session, signal, directory),
              );
          else if ('provider' in input) {
            try {
              const target = sessions.draftDirectory(input.directory);
              discovery = profiles
                .directory(input.provider, input.profileId, signal)
                .then(directory =>
                  discoverDirectorySkills(
                    input.provider,
                    target,
                    signal,
                    directory,
                  ),
                );
            } catch (error) {
              yield* Effect.tryPromise(() =>
                send({
                  type: 'error',
                  id: request.id,
                  code:
                    error instanceof SessionError
                      ? error.code
                      : 'invalid-directory',
                  message:
                    error instanceof SessionError
                      ? error.message
                      : 'The folder cannot be accessed.',
                }),
              );
              continue;
            }
          } else continue;
          skillRequests++;
          const inspection = discovery
            .then(catalog => send({ type: 'skills', id: request.id, catalog }))
            .catch(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'unavailable',
                message: session
                  ? 'Skills could not be checked. Verify the session directory and refresh.'
                  : 'Skills could not be checked for this folder. Verify the folder and refresh.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(inspection);
          void inspection.finally(() => {
            skillRequests--;
            probes.pending.delete(inspection);
          });
          continue;
        }
        if (
          request.method === 'read-code-review-settings' ||
          request.method === 'save-reviewer-profile' ||
          request.method === 'delete-reviewer-profile' ||
          request.method === 'save-review-convention' ||
          request.method === 'delete-review-convention' ||
          request.method === 'start-pull-request-review' ||
          request.method === 'list-pull-request-reviews' ||
          request.method === 'update-review-finding' ||
          request.method === 'discard-pull-request-review' ||
          request.method === 'publish-pull-request-review'
        ) {
          const { id } = request;
          const operation = async (): Promise<HostReply> => {
            switch (request.method) {
              case 'read-code-review-settings':
                return {
                  type: 'code-review-settings',
                  id,
                  settings: codeReviews.settings(),
                };
              case 'save-reviewer-profile':
                return {
                  type: 'code-review-settings',
                  id,
                  settings: codeReviews.saveProfile(request.input),
                };
              case 'delete-reviewer-profile':
                return {
                  type: 'code-review-settings',
                  id,
                  settings: codeReviews.deleteProfile(request.input),
                };
              case 'save-review-convention':
                return {
                  type: 'code-review-settings',
                  id,
                  settings: codeReviews.saveConvention(request.input),
                };
              case 'delete-review-convention':
                return {
                  type: 'code-review-settings',
                  id,
                  settings: codeReviews.deleteConvention(request.input),
                };
              case 'start-pull-request-review':
                return {
                  type: 'pull-request-review',
                  id,
                  draft: await codeReviews.start(request.input),
                };
              case 'list-pull-request-reviews':
                return {
                  type: 'pull-request-reviews',
                  id,
                  drafts: codeReviews.list(request.input),
                };
              case 'update-review-finding':
                return {
                  type: 'pull-request-review',
                  id,
                  draft: codeReviews.updateFinding(request.input),
                };
              case 'discard-pull-request-review':
                return {
                  type: 'pull-request-review',
                  id,
                  draft: codeReviews.discard(request.input),
                };
              case 'publish-pull-request-review':
                return {
                  type: 'pull-request-review-publish',
                  id,
                  result: await codeReviews.publish(request.input),
                };
            }
          };
          const pending = operation()
            .then(send)
            .catch(error => {
              const known =
                error instanceof CodeReviewError ||
                error instanceof PullRequestError ||
                error instanceof SessionError ||
                error instanceof FolderError;
              return send({
                type: 'error',
                id,
                code: known ? error.code : 'unavailable',
                message: known
                  ? error.message
                  : 'The code review operation failed.',
              });
            })
            .catch(() => undefined)
            .finally(() => {
              probes.pending.delete(pending);
            });
          probes.pending.add(pending);
          continue;
        }
        if (
          request.method === 'list-tracked-repositories' ||
          request.method === 'add-tracked-repository' ||
          request.method === 'remove-tracked-repository' ||
          request.method === 'reorder-tracked-repositories' ||
          request.method === 'suggest-tracked-repositories' ||
          request.method === 'list-tracked-pull-requests'
        ) {
          const { id } = request;
          const operation = async (): Promise<HostReply> => {
            switch (request.method) {
              case 'list-tracked-repositories':
                return {
                  type: 'tracked-repositories',
                  id,
                  repositories: trackedRepositories.list(),
                };
              case 'add-tracked-repository':
                return {
                  type: 'tracked-repositories',
                  id,
                  repositories: await trackedRepositories.add(request.input),
                };
              case 'remove-tracked-repository':
                return {
                  type: 'tracked-repositories',
                  id,
                  repositories: trackedRepositories.remove(request.input.id),
                };
              case 'reorder-tracked-repositories':
                return {
                  type: 'tracked-repositories',
                  id,
                  repositories: trackedRepositories.reorder(request.input.ids),
                };
              case 'suggest-tracked-repositories':
                return {
                  type: 'tracked-repository-suggestions',
                  id,
                  suggestions: await trackedRepositories.suggestions(),
                };
              case 'list-tracked-pull-requests':
                return {
                  type: 'tracked-pull-request-lists',
                  id,
                  lists: await trackedRepositories.pullRequestLists(
                    request.input,
                  ),
                };
            }
          };
          const pending = operation()
            .then(send)
            .catch(error => {
              const known =
                error instanceof PullRequestError ||
                error instanceof FolderError;
              return send({
                type: 'error',
                id,
                code: known ? error.code : 'unavailable',
                message: known
                  ? error.message
                  : 'The tracked repository operation failed.',
              });
            })
            .catch(() => undefined)
            .finally(() => {
              probes.pending.delete(pending);
            });
          probes.pending.add(pending);
          continue;
        }
        if (
          request.method === 'list-pull-requests' ||
          request.method === 'read-pull-request' ||
          request.method === 'read-pull-request-files' ||
          request.method === 'read-pull-request-threads' ||
          request.method === 'act-on-pull-request' ||
          request.method === 'find-session-pull-request'
        ) {
          const { id } = request;
          const operation = async (): Promise<HostReply> => {
            switch (request.method) {
              case 'list-pull-requests':
                return {
                  type: 'pull-request-list',
                  id,
                  list: await pullRequests.list(request.input),
                };
              case 'read-pull-request':
                return {
                  type: 'pull-request',
                  id,
                  pullRequest: await pullRequests.read(request.input),
                };
              case 'read-pull-request-files':
                return {
                  type: 'pull-request-files',
                  id,
                  files: await pullRequests.files(request.input),
                };
              case 'read-pull-request-threads':
                return {
                  type: 'pull-request-threads',
                  id,
                  threads: await pullRequests.threads(request.input),
                };
              case 'act-on-pull-request':
                return {
                  type: 'pull-request-action',
                  id,
                  result: await pullRequests.act(request.input),
                };
              case 'find-session-pull-request':
                return {
                  type: 'pull-request-reference',
                  id,
                  reference: await pullRequests.find(request.input.sessionId),
                };
            }
          };
          const pending = operation()
            .then(send)
            .catch(error => {
              const known =
                error instanceof PullRequestError ||
                error instanceof SessionError ||
                error instanceof FolderError;
              return send({
                type: 'error',
                id,
                code: known ? error.code : 'unavailable',
                message: known
                  ? error.message
                  : 'The GitHub pull request operation failed.',
              });
            })
            .catch(() => undefined)
            .finally(() => {
              probes.pending.delete(pending);
            });
          probes.pending.add(pending);
          continue;
        }
        if (
          request.method === 'list-workspace-directory' ||
          request.method === 'search-workspace-files' ||
          request.method === 'read-workspace-file' ||
          request.method === 'read-git-branch' ||
          request.method === 'read-session-changes' ||
          request.method === 'read-session-change-patch'
        ) {
          if (workspaceRequests >= 8) {
            yield* Effect.tryPromise(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'busy',
                message: 'Too many workspace requests. Try again shortly.',
              }),
            );
            continue;
          }
          workspaceRequests++;
          const operation = async (): Promise<HostReply> => {
            if (request.method === 'list-workspace-directory')
              return {
                type: 'workspace-directory',
                id: request.id,
                directory: await workspace.list(
                  request.input,
                  probes.controller.signal,
                ),
              };
            if (request.method === 'read-git-branch')
              return {
                type: 'git-branch',
                id: request.id,
                branch: request.input.directory
                  ? await readGitBranch(
                      await resolveFolder(
                        request.input.directory,
                        probes.controller.signal,
                      ),
                      probes.controller.signal,
                    )
                  : { kind: 'none' },
              };
            if (request.method === 'read-session-changes')
              return {
                type: 'session-changes',
                id: request.id,
                changes: await sessionChanges.read(
                  request.input,
                  probes.controller.signal,
                ),
              };
            if (request.method === 'read-session-change-patch')
              return {
                type: 'session-change-patch',
                id: request.id,
                patch: await sessionChanges.patch(
                  request.input,
                  probes.controller.signal,
                ),
              };
            if (request.method === 'search-workspace-files')
              return {
                type: 'workspace-search',
                id: request.id,
                search: await workspace.search(
                  request.input,
                  probes.controller.signal,
                ),
              };
            return {
              type: 'workspace-file',
              id: request.id,
              file: await workspace.read(
                request.input,
                probes.controller.signal,
              ),
            };
          };
          const pending = operation()
            .then(send)
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof WorkspaceError ||
                  error instanceof SessionError ||
                  error instanceof GitBranchError ||
                  error instanceof SessionChangeError ||
                  error instanceof FolderError
                    ? error.code
                    : 'unavailable',
                message:
                  error instanceof WorkspaceError ||
                  error instanceof SessionError ||
                  error instanceof GitBranchError ||
                  error instanceof SessionChangeError ||
                  error instanceof FolderError
                    ? error.message
                    : 'The workspace could not be read. Refresh and try again.',
              }),
            )
            .catch(() => undefined)
            .finally(() => {
              workspaceRequests--;
              probes.pending.delete(pending);
            });
          probes.pending.add(pending);
          continue;
        }
        if (
          request.method === 'stage-attachment' ||
          request.method === 'read-attachment' ||
          request.method === 'locate-attachment'
        ) {
          const operation = async (): Promise<HostReply> =>
            request.method === 'stage-attachment'
              ? {
                  type: 'attachment-upload',
                  id: request.id,
                  upload: await sessions.attachments.stage(request.input),
                }
              : request.method === 'read-attachment'
                ? {
                    type: 'attachment-content',
                    id: request.id,
                    content: await sessions.attachments.read(request.input.id),
                  }
                : {
                    type: 'attachment-location',
                    id: request.id,
                    location: await sessions.locateAttachment(request.input),
                  };
          const pending = operation()
            .then(send)
            .catch(error =>
              send({
                type: 'error',
                id: request.id,
                code:
                  error instanceof AttachmentError ||
                  error instanceof SessionError
                    ? error.code
                    : 'unavailable',
                message:
                  error instanceof AttachmentError
                    ? error.message
                    : error instanceof SessionError
                      ? error.message
                      : 'The attachment could not be stored or read on this computer.',
              }),
            )
            .catch(() => undefined)
            .finally(() => {
              probes.pending.delete(pending);
            });
          probes.pending.add(pending);
          continue;
        }
        const response = yield* Effect.sync((): HostReply => {
          try {
            if (request.method === 'read-costs')
              return {
                type: 'costs',
                id: request.id,
                report: costs.read(request.input),
              };
            if (request.method === 'list-cost-budgets')
              return {
                type: 'cost-budgets',
                id: request.id,
                list: costs.list(),
              };
            if (request.method === 'create-cost-budget') {
              const budget = costs.create(request.input);
              if (!budget)
                throw new SessionError(
                  'invalid-request',
                  'This computer already has 100 budgets.',
                );
              return { type: 'cost-budget', id: request.id, budget };
            }
            if (request.method === 'update-cost-budget') {
              if (!costs.update(request.input))
                throw new SessionError(
                  'not-found',
                  'This budget no longer exists.',
                );
              return {
                type: 'cost-budget',
                id: request.id,
                budget: request.input,
              };
            }
            if (request.method === 'delete-cost-budget') {
              if (!costs.delete(request.input.id))
                throw new SessionError(
                  'not-found',
                  'This budget no longer exists.',
                );
              return {
                type: 'cost-budget-deleted',
                id: request.id,
                deleted: request.input,
              };
            }
            if (request.method === 'link-session-pull-request')
              return {
                type: 'session',
                id: request.id,
                session: sessions.linkPullRequest(request.input),
              };
            if (request.method === 'list-reviews')
              return {
                type: 'reviews',
                id: request.id,
                reviews: sessions.listReviews(),
              };
            if (request.method === 'list-sessions')
              return {
                type: 'sessions',
                id: request.id,
                sessions: sessions.list(),
              };
            if (request.method === 'get-session')
              return {
                type: 'session',
                id: request.id,
                session: sessions.getSession(request.input),
              };
            if (request.method === 'read-session-messages')
              return {
                type: 'session-messages',
                id: request.id,
                page: sessions.readSessionMessages(request.input),
              };
            if (request.method === 'search-history')
              return {
                type: 'history-search',
                id: request.id,
                search: history.search(request.input),
              };
            if (request.method === 'create-session')
              return {
                type: 'session',
                id: request.id,
                session: sessions.create(request.input),
              };
            if (request.method === 'restart-session')
              return {
                type: 'session',
                id: request.id,
                session: sessions.restart(request.input),
              };
            if (request.method === 'compact-session')
              return {
                type: 'session',
                id: request.id,
                session: sessions.compact(request.input),
              };
            if (request.method === 'backup-database')
              return {
                type: 'database-backup',
                id: request.id,
                backup: backupDatabase(),
              };
            if (
              request.method === 'list-provider-profiles' ||
              request.method === 'rename-provider-profile' ||
              request.method === 'remove-provider-profile'
            ) {
              const list =
                request.method === 'list-provider-profiles'
                  ? profiles.list()
                  : request.method === 'rename-provider-profile'
                    ? profiles.rename(request.input)
                    : profiles.remove(request.input.profileId);
              return {
                type: 'provider-profiles',
                id: request.id,
                profiles: list,
              };
            }
            if (
              (request.method === 'create-session-group' ||
                request.method === 'update-session-group') &&
              request.input.defaults?.profileId &&
              request.input.defaults.provider
            )
              profiles.require(
                request.input.defaults.provider,
                request.input.defaults.profileId,
              );
            if (request.method === 'list-session-groups')
              return {
                type: 'session-groups',
                id: request.id,
                list: housekeeping.list(),
              };
            if (request.method === 'create-session-group')
              return {
                type: 'session-groups',
                id: request.id,
                list: housekeeping.createGroup(request.input),
              };
            if (request.method === 'update-session-group')
              return {
                type: 'session-groups',
                id: request.id,
                list: housekeeping.updateGroup(request.input),
              };
            if (request.method === 'move-session-group')
              return {
                type: 'session-groups',
                id: request.id,
                list: housekeeping.moveGroup(request.input),
              };
            if (request.method === 'delete-session-group')
              return {
                type: 'session-groups',
                id: request.id,
                list: housekeeping.deleteGroup(request.input),
              };
            if (request.method === 'move-session')
              return {
                type: 'session',
                id: request.id,
                session: housekeeping.moveSession(request.input),
              };
            if (request.method === 'rename-session')
              return {
                type: 'session',
                id: request.id,
                session: housekeeping.renameSession(request.input),
              };
            if (request.method === 'set-session-pinned')
              return {
                type: 'session',
                id: request.id,
                session: housekeeping.setPinned(request.input),
              };
            if (request.method === 'set-session-terminal')
              return {
                type: 'session',
                id: request.id,
                session: sessions.setTerminal(request.input),
              };
            if (request.method === 'set-session-archived')
              return {
                type: 'session',
                id: request.id,
                session: housekeeping.setArchived(request.input),
              };
            if (request.method === 'delete-session')
              return {
                type: 'session-deletion',
                id: request.id,
                deletion: deletions.delete(request.input),
              };
            if (request.method === 'restore-session')
              return {
                type: 'session',
                id: request.id,
                session: deletions.restore(request.input),
              };
            if (request.method === 'send-message')
              return {
                type: 'session',
                id: request.id,
                session: sessions.send(request.input),
              };
            if (request.method === 'queue-message')
              return {
                type: 'session',
                id: request.id,
                session: sessions.queue(request.input),
              };
            if (request.method === 'cancel-queued')
              return {
                type: 'session',
                id: request.id,
                session: sessions.cancelQueued(request.input),
              };
            if (request.method === 'start-queued')
              return {
                type: 'session',
                id: request.id,
                session: sessions.startQueued(request.input),
              };
            if (request.method === 'stop-run') {
              const bound = store.get(request.input.sessionId);
              if (
                bound?.workflowRunId &&
                sessions.isWorkflowTurnActive(bound.id, request.input.runId) &&
                workflowRunStore.getRun(bound.workflowRunId)?.sessionId ===
                  bound.id
              ) {
                try {
                  workflows.stop(bound.workflowRunId);
                } catch {
                  sessions.stopActive(bound.id);
                }
              }
              return {
                type: 'session',
                id: request.id,
                session: sessions.stop(request.input),
              };
            }
            if (request.method === 'respond-approval')
              return {
                type: 'session',
                id: request.id,
                session: sessions.respondApproval(request.input),
              };
            if (request.method === 'decide-delegation')
              return {
                type: 'session',
                id: request.id,
                session: sessions.decideDelegation(request.input),
              };
            if (request.method === 'decide-worker-plan')
              return {
                type: 'session',
                id: request.id,
                session: sessions.decideWorkerPlan(request.input),
              };
            if (request.method === 'list-scheduled-jobs')
              return {
                type: 'scheduled-jobs',
                id: request.id,
                list: { scheduledJobs: scheduledJobs.list() },
              };
            if (request.method === 'save-scheduled-job')
              return {
                type: 'scheduled-job',
                id: request.id,
                scheduledJob: scheduledJobs.save(request.input),
              };
            if (request.method === 'set-scheduled-job-active')
              return {
                type: 'scheduled-job',
                id: request.id,
                scheduledJob: scheduledJobs.setActive(request.input),
              };
            if (request.method === 'delete-scheduled-job') {
              scheduledJobs.delete(request.input);
              return {
                type: 'scheduled-job-deleted',
                id: request.id,
                scheduledJobId: request.input.id,
              };
            }
            if (request.method === 'list-scheduled-job-runs')
              return {
                type: 'scheduled-job-runs',
                id: request.id,
                page: scheduledJobs.listRuns(request.input),
              };
            if (request.method === 'run-scheduled-job-now')
              return {
                type: 'scheduled-job-run',
                id: request.id,
                run: scheduledJobs.runNow(request.input),
              };
            if (request.method === 'decide-scheduled-job-start')
              return {
                type: 'scheduled-job',
                id: request.id,
                scheduledJob: scheduledJobs.decideStart(request.input),
              };
            if (request.method === 'get-workflow-run') {
              const run = workflowRunStore.getRun(request.input.runId);
              if (!run)
                throw new WorkflowRunError(
                  'not-found',
                  'Workflow run not found.',
                );
              return {
                type: 'workflow-run-detail',
                id: request.id,
                detail: {
                  run,
                  steps: workflowRunStore.stepsForRun(run.id),
                },
              };
            }
            if (request.method === 'list-workflow-runs') {
              const page = workflowRunStore.listRuns(
                request.input.cursor,
                request.input.limit,
              );
              if (!page)
                throw new WorkflowRunError(
                  'invalid-request',
                  'The run list cursor is invalid. Refresh the list.',
                );
              return { type: 'workflow-runs', id: request.id, page };
            }
            if (request.method === 'resume-workflow-run')
              return {
                type: 'workflow-run',
                id: request.id,
                run: workflows.resume(request.input.runId),
              };
            if (request.method === 'skip-workflow-step')
              return {
                type: 'workflow-run',
                id: request.id,
                run: gates.skip(request.input),
              };
            if (request.method === 'resolve-workflow-step')
              return {
                type: 'workflow-run',
                id: request.id,
                run: gates.resolve(request.input),
              };
            if (request.method === 'stop-workflow-run')
              return {
                type: 'workflow-run',
                id: request.id,
                run: workflows.stop(request.input.runId),
              };
            const row = database
              .prepare('SELECT value FROM metadata WHERE key = ?')
              .get('instance_id');
            const quarantinedSessionCount = store.quarantinedCount();
            return {
              type: 'health',
              id: request.id,
              health: hostHealthSchema.parse({
                status: 'ready',
                instanceId: row?.value,
                protocolVersion: 1,
                contractRevision: HOST_CONTRACT_REVISION,
                capabilities: [...ADVERTISED_CAPABILITIES],
                ...(quarantinedSessionCount ? { quarantinedSessionCount } : {}),
              }),
            };
          } catch (error) {
            const known =
              error instanceof SessionError ||
              error instanceof ScheduledJobError ||
              error instanceof WorkflowRunError;
            return {
              type: 'error',
              id: request.id,
              code: known ? error.code : 'unavailable',
              message: known
                ? error.message
                : 'The host could not complete this operation. Refresh and try again.',
            };
          }
        });
        yield* Effect.tryPromise(() => send(response));
      }
    }),
  );

export const runHost = (transport: HostTransport) =>
  Effect.runPromise(serveHost(transport));
