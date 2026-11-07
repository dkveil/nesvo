import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import {
  hostMessageSchema,
  hostRequestSchema,
  type CreateSessionInput,
  type DesktopEvent,
  type SendMessageInput,
  type StopRunInput,
  type HostRequest,
  type HostResponse,
} from '@nesvo/contracts';

export function startHost(directory: string) {
  const child = utilityProcess.fork(
    join(import.meta.dirname, 'host-entry.js'),
    [],
    {
      serviceName: 'Nesvo Host',
      env: { ...process.env, NESVO_DATA_DIR: directory },
      stdio: 'pipe',
    },
  );
  const pending = new Map<
    string,
    {
      resolve: (value: HostResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let exited = false;
  const listeners = new Set<(event: DesktopEvent) => void>();
  const closed = new Promise<void>(resolve => {
    child.once('exit', () => {
      exited = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Host stopped'));
      }
      pending.clear();
      for (const listener of listeners) listener({ type: 'host-disconnected' });
      resolve();
    });
  });
  child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
  child.on('message', (value: unknown) => {
    const parsed = hostMessageSchema.safeParse(value);
    if (!parsed.success) return;
    if (
      parsed.data.type === 'session-changed' ||
      parsed.data.type === 'host-disconnected'
    ) {
      for (const listener of listeners) listener(parsed.data);
      return;
    }
    if (!parsed.data.id) return;
    const request = pending.get(parsed.data.id);
    if (!request) return;
    pending.delete(parsed.data.id);
    clearTimeout(request.timer);
    if (parsed.data.type === 'error')
      request.reject(new Error(parsed.data.message ?? 'Host unavailable'));
    else request.resolve(parsed.data);
  });
  const request = (method: HostRequest['method'], input?: unknown) =>
    new Promise<HostResponse>((resolve, reject) => {
      if (exited) {
        reject(new Error('Host unavailable'));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error('Host timed out'));
        },
        method === 'claude-status' ? 30000 : 15000,
      );
      pending.set(id, { resolve, reject, timer });
      try {
        child.postMessage(
          hostRequestSchema.parse({
            id,
            method,
            ...(input === undefined ? {} : { input }),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error('Host unavailable'));
      }
    });
  return {
    child,
    subscribe: (listener: (event: DesktopEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    health: async () => {
      const response = await request('health');
      if (response.type !== 'health') throw new Error('Host unavailable');
      return response.health;
    },
    claudeStatus: async () => {
      const response = await request('claude-status');
      if (response.type !== 'claude-status')
        throw new Error('Unexpected host response');
      return response.status;
    },
    listSessions: async () => {
      const response = await request('list-sessions');
      if (response.type !== 'sessions')
        throw new Error('Unexpected host response');
      return response.sessions;
    },
    createSession: async (input: CreateSessionInput) => {
      const response = await request('create-session', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    sendMessage: async (input: SendMessageInput) => {
      const response = await request('send-message', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    stopRun: async (input: StopRunInput) => {
      const response = await request('stop-run', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    stop: async () => {
      if (exited) return;
      const timer = setTimeout(() => {
        child.kill();
      }, 15000);
      try {
        await request('shutdown').catch(() => undefined);
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
