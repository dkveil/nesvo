import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import {
  hostResponseSchema,
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
  const closed = new Promise<void>(resolve => {
    child.once('exit', () => {
      exited = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Host stopped'));
      }
      pending.clear();
      resolve();
    });
  });
  child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
  child.on('message', (value: unknown) => {
    const parsed = hostResponseSchema.safeParse(value);
    if (!parsed.success || !parsed.data.id) return;
    const request = pending.get(parsed.data.id);
    if (!request) return;
    pending.delete(parsed.data.id);
    clearTimeout(request.timer);
    request.resolve(parsed.data);
  });
  const request = (method: HostRequest['method']) =>
    new Promise<HostResponse>((resolve, reject) => {
      if (exited) {
        reject(new Error('Host unavailable'));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Host timed out'));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.postMessage({ id, method });
    });
  return {
    child,
    health: async () => {
      const response = await request('health');
      if (response.type !== 'health') throw new Error('Host unavailable');
      return response.health;
    },
    stop: async () => {
      if (exited) return;
      const timer = setTimeout(() => {
        child.kill();
      }, 2000);
      try {
        await request('shutdown').catch(() => undefined);
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
