import { lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import {
  hostConnectSchema,
  hostRequestSchema,
  type HostConnection,
  type HostHealth,
} from '@nesvo/contracts';
import { Effect } from 'effect';
import { ownDataDirectory } from './database';
import { DaemonRuntime } from './daemon-runtime';
import {
  privateDirectory,
  privateSocketPath,
  readFrames,
  requestFrameLimit,
  sendFrame,
} from './daemon-channel';

type Connection = {
  socket: Socket;
  ready: boolean;
  closing: boolean;
  pending: Map<string, () => void>;
};

async function removeStaleSocket(socketPath: string) {
  const previous = await lstat(socketPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!previous) return;
  if (!previous.isSocket())
    throw new Error('The private socket path contains a different file.');
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath);
    const timeout = setTimeout(() => {
      probe.destroy();
      reject(new Error('The existing socket could not be checked.'));
    }, 1000);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error('Another process is listening on the private socket.'));
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    probe.once('close', () => clearTimeout(timeout));
  });
  const current = await lstat(socketPath);
  if (
    !current.isSocket() ||
    current.ino !== previous.ino ||
    current.dev !== previous.dev
  )
    throw new Error('The private socket changed while it was being checked.');
  await unlink(socketPath);
}

async function serveSocket(
  directory: string,
  socketPath: string,
  signal: AbortSignal,
  ready: (health: HostHealth) => void,
) {
  const clients = new Set<Connection>();
  const runtime = new DaemonRuntime(directory, event => {
    for (const client of clients)
      if (client.ready && !client.closing) sendFrame(client.socket, event);
  });
  const server = createServer();
  let health: HostHealth;
  let resolveEnded!: () => void;
  let rejectEnded!: (error: unknown) => void;
  const ended = new Promise<void>((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });
  const stop = () => resolveEnded();
  signal.addEventListener('abort', stop, { once: true });
  server.on('error', rejectEnded);
  void runtime.done.then(resolveEnded, rejectEnded);
  void ended.catch(() => undefined);

  try {
    health = await runtime.health();
    if (signal.aborted) return;
    await removeStaleSocket(socketPath);
    server.on('connection', socket => {
      const client: Connection = {
        socket,
        ready: false,
        closing: false,
        pending: new Map(),
      };
      const reject = (
        code: Extract<HostConnection, { type: 'connection-error' }>['code'],
      ) => {
        if (client.closing) return;
        client.closing = true;
        sendFrame(socket, { type: 'connection-error', code });
        socket.end();
        const timer = setTimeout(() => socket.destroy(), 250);
        timer.unref();
        socket.once('close', () => clearTimeout(timer));
      };
      socket.on('error', () => socket.destroy());
      if (clients.size >= 8 || signal.aborted) {
        reject('busy');
        return;
      }
      clients.add(client);
      const timeout = setTimeout(() => reject('invalid-handshake'), 10_000);
      const detach = readFrames(
        socket,
        requestFrameLimit,
        value => {
          if (client.closing) return;
          if (!client.ready) {
            if (
              typeof value === 'object' &&
              value !== null &&
              'type' in value &&
              value.type === 'connect' &&
              'protocolVersion' in value &&
              value.protocolVersion !== 1
            ) {
              reject('incompatible-protocol');
              return;
            }
            const parsed = hostConnectSchema.safeParse(value);
            if (!parsed.success) {
              reject('invalid-handshake');
              return;
            }
            if (
              parsed.data.expectedInstanceId &&
              parsed.data.expectedInstanceId !== health.instanceId
            ) {
              reject('identity-mismatch');
              return;
            }
            clearTimeout(timeout);
            sendFrame(socket, { type: 'connected', health });
            client.ready = true;
            return;
          }
          const parsed = hostRequestSchema.safeParse(value);
          if (!parsed.success) {
            sendFrame(socket, {
              type: 'error',
              id: null,
              code: 'invalid-request',
            });
            return;
          }
          const request = parsed.data;
          if (request.method === 'shutdown') {
            sendFrame(socket, {
              type: 'error',
              id: request.id,
              code: 'invalid-request',
              message:
                'Disconnect this client or stop the service on the host.',
            });
            return;
          }
          if (client.pending.has(request.id)) {
            reject('invalid-frame');
            return;
          }
          if (client.pending.size >= 32) {
            sendFrame(socket, { type: 'error', id: request.id, code: 'busy' });
            return;
          }
          const cancelReply = runtime.submit(request, response => {
            client.pending.delete(request.id);
            if (!client.closing) sendFrame(socket, response);
          });
          if (!cancelReply) {
            sendFrame(socket, { type: 'error', id: request.id, code: 'busy' });
            return;
          }
          client.pending.set(request.id, cancelReply);
        },
        () => reject('invalid-frame'),
      );
      socket.once('close', () => {
        clearTimeout(timeout);
        detach();
        for (const cancel of client.pending.values()) cancel();
        client.pending.clear();
        clients.delete(client);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (!signal.aborted) ready(health);
    else stop();
    await ended;
  } finally {
    signal.removeEventListener('abort', stop);
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const client of clients) client.socket.destroy();
    await closed;
    await runtime.stop();
  }
}

export async function runDaemon(
  directory: string,
  runtimeDirectory: string,
  ready: (health: HostHealth) => void,
) {
  process.umask(0o077);
  if (resolve(directory) === resolve(runtimeDirectory))
    throw new Error('Data and runtime directories must be separate.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const socketPath = await privateSocketPath(runtimeDirectory, true);
    await privateDirectory(directory, true);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ownDataDirectory(runtimeDirectory);
          yield* Effect.tryPromise(() =>
            serveSocket(directory, socketPath, controller.signal, ready),
          );
        }),
      ),
    );
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
