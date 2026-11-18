import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  externalInboxDeviceSchema,
  externalInboxLimits,
  externalInboxRequestSchema,
  type ExternalInboxErrorCode,
  type ExternalInboxItem,
  type ExternalInboxReply,
} from '@nesvo/contracts';
import { readFrames, sendFrame } from './daemon-channel';
import type { InboxRules } from './inbox-rules/service';
import {
  externalInboxEndpoint,
  externalInboxFrameLimit,
} from './external-inbox-endpoint';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

const errors: Record<ExternalInboxErrorCode, string> = {
  unauthorized: 'The Inbox device token is invalid or revoked.',
  'invalid-request': 'The Inbox request is invalid.',
  'not-found': 'The Inbox item or linked session was not found.',
  conflict: 'This idempotency key already belongs to a different post.',
  'rate-limit': 'This device has reached its posts-per-minute limit.',
  'pending-limit': 'The pending Inbox limit was reached.',
  unavailable: 'The external Inbox is unavailable.',
};

const failure = (code: ExternalInboxErrorCode): ExternalInboxReply => ({
  ok: false,
  code,
  message: errors[code],
});

function result(item: ExternalInboxItem): ExternalInboxReply {
  return {
    ok: true,
    item: {
      id: item.id,
      status: item.status,
      action: item.answer,
      actionIndex:
        item.answer === null ? null : item.options.indexOf(item.answer),
      comment: item.note,
    },
  };
}

export class ExternalInbox {
  constructor(
    private readonly database: DatabaseSync,
    private readonly inbox: InboxRules,
    readonly computerId: string,
  ) {}

  list() {
    return this.database
      .prepare(
        'SELECT id, name, created_at AS createdAt FROM external_inbox_devices ORDER BY created_at, id',
      )
      .all()
      .map(row => externalInboxDeviceSchema.parse(row));
  }

  enroll(name: string) {
    if (this.list().length >= externalInboxLimits.devices)
      throw new Error('Revoke an Inbox device before creating another.');
    const device = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
    };
    const token = `${this.computerId}.${randomBytes(32).toString('base64url')}`;
    this.database
      .prepare(
        'INSERT INTO external_inbox_devices (id, name, created_at, token_hash) VALUES (?, ?, ?, ?)',
      )
      .run(device.id, device.name, device.createdAt, hash(token));
    return { device, token };
  }

  revoke(deviceId: string) {
    this.database
      .prepare('DELETE FROM external_inbox_devices WHERE id = ?')
      .run(deviceId);
    return this.list();
  }

  async execute(
    value: unknown,
    signal: AbortSignal,
  ): Promise<ExternalInboxReply> {
    const input = externalInboxRequestSchema.safeParse(value);
    if (!input.success) return failure('invalid-request');
    const { token, command } = input.data;
    if (!token.startsWith(`${this.computerId}.`))
      return failure('unauthorized');
    const fingerprint = hash(token);
    const select = this.database.prepare(
      'SELECT id, name FROM external_inbox_devices WHERE token_hash = ?',
    );
    const device = select.get(fingerprint);
    if (!device) return failure('unauthorized');
    const deviceId = String(device.id);
    try {
      if (command.operation === 'post') {
        const item = await this.inbox.postExternal(
          deviceId,
          String(device.name),
          command.item,
          () => !signal.aborted && !!select.get(fingerprint),
        );
        return typeof item === 'string' ? failure(item) : result(item);
      }
      const item = this.inbox.externalItem(deviceId, command.itemId);
      if (!item) return failure('not-found');
      return result(
        command.operation === 'cancel' ? this.inbox.cancelExternal(item) : item,
      );
    } catch {
      return failure('unavailable');
    }
  }
}

export async function listenForExternalInbox(inbox: ExternalInbox) {
  const endpoint = externalInboxEndpoint(inbox.computerId);
  if (process.platform !== 'win32') {
    const directory = join(tmpdir(), `nesvo-inbox-${process.getuid?.()}`);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error('The Inbox socket directory must be private.');
    const previous = await lstat(endpoint).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (previous) {
      if (!previous.isSocket())
        throw new Error('The Inbox socket path is occupied.');
      const alive = await new Promise<boolean>(resolve => {
        const probe = createConnection(endpoint);
        probe.once('connect', () => {
          resolve(true);
          probe.destroy();
        });
        probe.once('error', (error: NodeJS.ErrnoException) =>
          resolve(error.code !== 'ECONNREFUSED'),
        );
        probe.setTimeout(1000, () => {
          resolve(true);
          probe.destroy();
        });
      });
      const current = await lstat(endpoint);
      if (alive || current.ino !== previous.ino || current.dev !== previous.dev)
        throw new Error('The Inbox socket path is occupied.');
      await unlink(endpoint);
    }
  }
  const connections = new Set<Socket>();
  const lifetime = new AbortController();
  const server = createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    let received = false;
    readFrames(
      socket,
      externalInboxFrameLimit,
      value => {
        if (received) {
          socket.destroy();
          return;
        }
        received = true;
        void inbox.execute(value, lifetime.signal).then(
          reply => {
            sendFrame(socket, reply);
            socket.end();
          },
          () => socket.destroy(),
        );
      },
      () => socket.destroy(),
    );
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', () => server.close());
  return () =>
    new Promise<void>(resolve => {
      lifetime.abort();
      for (const socket of connections) socket.destroy();
      server.close(() => resolve());
    });
}
