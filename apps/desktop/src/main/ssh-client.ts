import { randomUUID } from 'node:crypto';
import {
  hostConnectionSchema,
  hostMessageSchema,
  hostRequestSchema,
  type DesktopEvent,
  type HostHealth,
  type HostRequest,
  type HostResponse,
  type SshComputerInput,
} from '@nesvo/contracts';
import { spawnSshBridge } from './ssh-transport';

export function connectSshHost(
  target: SshComputerInput,
  expectedInstanceId?: string,
) {
  const child = spawnSshBridge(target, expectedInstanceId);
  const listeners = new Set<(event: DesktopEvent) => void>();
  const pending = new Map<
    string,
    {
      resolve: (response: HostResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let resolveReady!: (health: HostHealth) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<HostHealth>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve;
  });
  let settled = false;
  let greeted = false;
  let stderr = '';
  let buffer = Buffer.alloc(4096);
  let size = 0;
  const failure = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(handshakeTimer);
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const listener of listeners) listener({ type: 'host-disconnected' });
    child.kill();
  };
  const handshakeTimer = setTimeout(
    () =>
      failure(
        new Error(
          'SSH connection timed out. Check the server and host service.',
        ),
      ),
    25_000,
  );
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (value: string) => {
    stderr = (stderr + value).slice(-3000);
  });
  const receive = (value: unknown) => {
    if (settled) return;
    if (!greeted) {
      const parsed = hostConnectionSchema.safeParse(value);
      if (!parsed.success || parsed.data.type !== 'connected') {
        failure(
          new Error(
            parsed.success && parsed.data.type === 'connection-error'
              ? `The host refused the connection: ${parsed.data.code}.`
              : 'The host returned an invalid handshake.',
          ),
        );
        return;
      }
      if (
        expectedInstanceId &&
        expectedInstanceId !== parsed.data.health.instanceId
      ) {
        failure(
          new Error(
            'This connection reached a different Nesvo host. Check the server and its data directory.',
          ),
        );
        return;
      }
      greeted = true;
      clearTimeout(handshakeTimer);
      resolveReady(parsed.data.health);
      return;
    }
    const parsed = hostMessageSchema.safeParse(value);
    if (!parsed.success) {
      failure(new Error('The host returned an invalid response.'));
      return;
    }
    const message = parsed.data;
    if (!('id' in message)) {
      for (const listener of listeners) listener(message);
      return;
    }
    if (!message.id) {
      failure(new Error('The host rejected a protocol request.'));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.type === 'error')
      request.reject(
        new Error(message.message ?? `Host request failed: ${message.code}.`),
      );
    else request.resolve(message);
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (settled) return;
    let offset = 0;
    while (offset < chunk.length && !settled) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const needed = size + end - offset;
      if (needed > 64 * 1024 * 1024) {
        failure(new Error('The host response exceeded the connection limit.'));
        return;
      }
      if (needed > buffer.length) {
        const next = Buffer.allocUnsafe(
          Math.min(64 * 1024 * 1024, Math.max(needed, buffer.length * 2)),
        );
        buffer.copy(next, 0, 0, size);
        buffer = next;
      }
      chunk.copy(buffer, size, offset, end);
      size = needed;
      if (newline === -1) break;
      try {
        receive(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              buffer.subarray(0, size),
            ),
          ),
        );
      } catch {
        failure(new Error('The host sent a malformed frame.'));
      }
      size = 0;
      offset = newline + 1;
    }
  });
  child.stdin.on('error', () =>
    failure(
      new Error(
        'The SSH connection closed while sending. Refresh the host state before retrying.',
      ),
    ),
  );
  child.once('error', () =>
    failure(
      new Error(
        'OpenSSH could not start. Install an SSH client and check its availability.',
      ),
    ),
  );
  child.once('close', () => {
    const detail = stderr
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trim()
      .slice(-1600);
    failure(
      new Error(
        detail
          ? `SSH disconnected. ${detail}`
          : 'The SSH connection closed. Work on the host may still be running.',
      ),
    );
    resolveClosed();
  });
  const request = (method: HostRequest['method'], input?: unknown) =>
    new Promise<HostResponse>((resolve, reject) => {
      if (!greeted || settled) {
        reject(
          new Error(
            'This computer is offline. Reconnect before sending a command.',
          ),
        );
        return;
      }
      if (method === 'shutdown') {
        reject(new Error('Disconnecting must not stop the remote host.'));
        return;
      }
      if (pending.size >= 24) {
        reject(new Error('This connection is busy. Try again shortly.'));
        return;
      }
      const id = randomUUID();
      const payload = hostRequestSchema.parse({
        id,
        method,
        ...(input === undefined ? {} : { input }),
      });
      const line = JSON.stringify(payload) + '\n';
      if (
        Buffer.byteLength(line) > 1024 * 1024 ||
        child.stdin.writableLength + Buffer.byteLength(line) > 2 * 1024 * 1024
      ) {
        reject(new Error('This request exceeds the connection limit.'));
        return;
      }
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(
            new Error(
              'The host did not reply in time. Refresh its state before retrying; the operation may have completed.',
            ),
          );
        },
        method === 'discover-skills'
          ? 60_000
          : method === 'provider-usage'
            ? 40_000
            : method === 'claude-status' || method === 'codex-status'
              ? 30_000
              : 15_000,
      );
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(line);
    });
  return {
    ready,
    request,
    subscribe: (listener: (event: DesktopEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    disconnect: async () => {
      failure(new Error('Disconnected from this computer.'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error('SSH process shutdown could not be confirmed.'),
                ),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
