import {
  hostHealthSchema,
  hostRequestSchema,
  claudeStatusSchema,
  codexStatusSchema,
  type HostMessage,
  type HostResponse,
} from '@nesvo/contracts';
import { Effect } from 'effect';
import { openDatabase } from './database';
import { inspectClaude } from './providers/claude';
import { inspectCodex } from './providers/codex';
import { SessionService, SessionError } from './sessions/service';
import { SessionStore } from './sessions/store';
import { ReviewStore } from './review/store';
import { WorkspaceError, WorkspaceFiles } from './workspace/files';

type HostTransport = {
  directory: string;
  incoming: AsyncIterable<unknown>;
  send: (response: HostMessage) => Promise<void>;
};

export const serveHost = ({ directory, incoming, send }: HostTransport) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* openDatabase(directory);
      const store = new SessionStore(database);
      const workspace = new WorkspaceFiles(id => store.get(id));
      let outgoing = Promise.resolve();
      const emit = (message: HostMessage) => {
        outgoing = outgoing.then(() => send(message)).catch(() => undefined);
      };
      const sessions = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new SessionService(
              store,
              directory,
              emit,
              new ReviewStore(database),
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
            state.controller.abort();
            await Promise.all(state.pending);
          }),
      );
      let workspaceRequests = 0;
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
        if (request.method === 'shutdown') {
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
        if (
          request.method === 'list-workspace-directory' ||
          request.method === 'search-workspace-files' ||
          request.method === 'read-workspace-file'
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
                  error instanceof WorkspaceError ? error.code : 'unavailable',
                message:
                  error instanceof WorkspaceError
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
            if (request.method === 'stop-run')
              return {
                type: 'session',
                id: request.id,
                session: sessions.stop(request.input),
              };
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
              }),
            };
          } catch (error) {
            return {
              type: 'error',
              id: request.id,
              code: error instanceof SessionError ? error.code : 'unavailable',
              message:
                error instanceof SessionError
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
