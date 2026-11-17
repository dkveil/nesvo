import {
  hostHealthSchema,
  hostCapabilitySchema,
  hostRequestSchema,
  claudeStatusSchema,
  codexStatusSchema,
  isWorkflowMethod,
  type DefinitionCatalog,
  type DefinitionWriteResult,
  type HostMessage,
  type HostRequest,
  type HostResponse,
  type Session,
  type SkillCatalog,
} from '@nesvo/contracts';
import { Effect } from 'effect';
import { openDatabase, ownDataDirectory } from './database';
import { inspectClaude } from './providers/claude';
import { inspectCodex } from './providers/codex';
import { SessionService, SessionError } from './sessions/service';
import { SessionStore } from './sessions/store';
import { ReviewStore } from './review/store';
import { PullRequests } from './pull-requests';
import { PullRequestError } from './process/github-cli';
import { WorkspaceError, WorkspaceFiles } from './workspace/files';
import { FolderError, resolveFolder } from './workspace/folder';
import { GitBranchError, readGitBranch } from './workspace/git-branch';
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
  'create-session',
  'send-message',
  'queue-message',
  'assign-session-workflow',
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

export const serveHost = ({ directory, incoming, send }: HostTransport) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ownDataDirectory(directory);
      const database = yield* openDatabase(directory);
      const store = new SessionStore(database);
      const scheduledJobStore = new ScheduledJobStore(database);
      const workflowRunStore = new WorkflowRunStore(database);
      const reviewStore = new ReviewStore(database);
      const workspace = new WorkspaceFiles(id => store.get(id));
      let outgoing = Promise.resolve();
      const emit = (message: HostMessage) => {
        outgoing = outgoing.then(() => send(message)).catch(() => undefined);
      };
      let wakeIdleRuns = () => {};
      let observeAssistant: (session: Session) => void = () => {};
      const emitSessionEvent = (message: HostMessage) => {
        emit(message);
        if (message.type !== 'session-changed') return;
        wakeIdleRuns();
        observeAssistant(message.session);
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
                environment: session => {
                  const run = session.workflowRunId
                    ? workflowRunStore.getRun(session.workflowRunId)
                    : undefined;
                  return run ? runEnvironment(run) : undefined;
                },
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
      const pullRequests = new PullRequests(
        probes.controller.signal,
        id => store.get(id),
        (id, run) =>
          sessions
            .withPullRequestCheckout(id, run)
            .finally(() => wakeIdleRuns()),
      );
      const usage = new ProviderUsageService(probes.controller.signal);
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
              action: actionExecutor,
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
            new SessionLauncher(sessions, usage, undefined, undefined, {
              start: (input, signal) => tasks.start(input, signal),
              getRun: id => workflowRunStore.getRun(id),
              stop: id => workflows.stop(id),
            }),
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
      let workspaceRequests = 0;
      let skillRequests = 0;
      let definitionRequests = 0;
      let definitionWrites = 0;
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
            : request.method === 'create-session' && request.input.isolation
              ? 'Workspace isolation is not available on this host yet.'
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
          yield* Effect.promise(() => scheduledJobs.close());
          yield* Effect.promise(() => workflows.close());
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
          const inspection = (
            request.method === 'claude-status'
              ? inspectClaude(probes.controller.signal)
              : inspectCodex(probes.controller.signal)
          )
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
            .catch(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'unavailable',
                message: 'The provider could not be checked. Try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(inspection);
          void inspection.finally(() => probes.pending.delete(inspection));
          continue;
        }
        if (request.method === 'provider-usage') {
          const inspection = usage
            .read(request.input)
            .then(usage =>
              send({ type: 'provider-usage', id: request.id, usage }),
            )
            .catch(() =>
              send({
                type: 'error',
                id: request.id,
                code: 'unavailable',
                message: 'Account limits could not be read.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(inspection);
          void inspection.finally(() => probes.pending.delete(inspection));
          continue;
        }
        if (request.method === 'create-session' && request.input.effort) {
          const creation = sessions
            .createWithEffort(request.input, probes.controller.signal)
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
                    : 'The session could not be created. Refresh Codex and try again.',
              }),
            )
            .catch(() => undefined);
          probes.pending.add(creation);
          void creation.finally(() => probes.pending.delete(creation));
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
          if (session)
            discovery = discoverSessionSkills(
              session,
              probes.controller.signal,
            );
          else if ('provider' in input) {
            try {
              discovery = discoverDirectorySkills(
                input.provider,
                sessions.draftDirectory(input.directory),
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
          request.method === 'list-pull-requests' ||
          request.method === 'read-pull-request' ||
          request.method === 'read-pull-request-files' ||
          request.method === 'read-pull-request-threads' ||
          request.method === 'act-on-pull-request' ||
          request.method === 'find-session-pull-request'
        ) {
          const { id } = request;
          const operation = async (): Promise<HostResponse> => {
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
          request.method === 'read-git-branch'
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
          const operation = async (): Promise<HostResponse> => {
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
                  error instanceof FolderError
                    ? error.code
                    : 'unavailable',
                message:
                  error instanceof WorkspaceError ||
                  error instanceof SessionError ||
                  error instanceof GitBranchError ||
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
        const response = yield* Effect.sync((): HostResponse => {
          try {
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
            if (request.method === 'create-session')
              return {
                type: 'session',
                id: request.id,
                session: sessions.create(request.input),
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
            return {
              type: 'health',
              id: request.id,
              health: hostHealthSchema.parse({
                status: 'ready',
                instanceId: row?.value,
                protocolVersion: 1,
                capabilities: [...ADVERTISED_CAPABILITIES],
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
