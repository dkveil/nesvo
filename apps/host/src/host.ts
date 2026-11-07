import {
  hostHealthSchema,
  hostRequestSchema,
  type HostResponse,
} from '@nesvo/contracts';
import { Effect } from 'effect';
import { openDatabase } from './database';

type HostTransport = {
  directory: string;
  incoming: AsyncIterable<unknown>;
  send: (response: HostResponse) => Promise<void>;
};

export const serveHost = ({ directory, incoming, send }: HostTransport) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* openDatabase(directory);
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
          yield* Effect.tryPromise(() =>
            send({ type: 'shutdown', id: request.id }),
          );
          return;
        }
        const response = yield* Effect.sync((): HostResponse => {
          try {
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
          } catch {
            return { type: 'error', id: request.id, code: 'unavailable' };
          }
        });
        yield* Effect.tryPromise(() => send(response));
      }
    }),
  );

export const runHost = (transport: HostTransport) =>
  Effect.runPromise(serveHost(transport));
