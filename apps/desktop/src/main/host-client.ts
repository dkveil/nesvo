import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import {
  hostMessageSchema,
  hostRequestSchema,
  type CreateSessionInput,
  type DecideDelegationInput,
  type DecideReviewInput,
  type DesktopEvent,
  type SendMessageInput,
  type RespondApprovalInput,
  type StopRunInput,
  type HostRequest,
  type HostResponse,
  type ListWorkspaceDirectoryInput,
  type SearchWorkspaceFilesInput,
  type ReadWorkspaceFileInput,
  type DiscoverSkillsInput,
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
    if (!('id' in parsed.data)) {
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
        method === 'discover-skills'
          ? 60000
          : method === 'provider-usage'
            ? 40000
            : method === 'claude-status' ||
                method === 'codex-status' ||
                method === 'create-session'
              ? 30000
              : 15000,
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
    request,
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
    codexStatus: async () => {
      const response = await request('codex-status');
      if (response.type !== 'codex-status')
        throw new Error('Unexpected host response');
      return response.status;
    },
    decideDelegation: async (input: DecideDelegationInput) => {
      const response = await request('decide-delegation', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    respondApproval: async (input: RespondApprovalInput) => {
      const response = await request('respond-approval', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    listSessions: async () => {
      const response = await request('list-sessions');
      if (response.type !== 'sessions')
        throw new Error('Unexpected host response');
      return response.sessions;
    },
    listReviews: async () => {
      const response = await request('list-reviews');
      if (response.type !== 'reviews')
        throw new Error('Unexpected host response');
      return response.reviews;
    },
    discoverSkills: async (input: DiscoverSkillsInput) => {
      const response = await request('discover-skills', input);
      if (response.type !== 'skills')
        throw new Error('Unexpected host response');
      return response.catalog;
    },
    listWorkspaceDirectory: async (input: ListWorkspaceDirectoryInput) => {
      const response = await request('list-workspace-directory', input);
      if (response.type !== 'workspace-directory')
        throw new Error('Unexpected host response');
      return response.directory;
    },
    searchWorkspaceFiles: async (input: SearchWorkspaceFilesInput) => {
      const response = await request('search-workspace-files', input);
      if (response.type !== 'workspace-search')
        throw new Error('Unexpected host response');
      return response.search;
    },
    readWorkspaceFile: async (input: ReadWorkspaceFileInput) => {
      const response = await request('read-workspace-file', input);
      if (response.type !== 'workspace-file')
        throw new Error('Unexpected host response');
      return response.file;
    },
    decideReview: async (input: DecideReviewInput) => {
      const response = await request('decide-review', input);
      if (response.type !== 'review')
        throw new Error('Unexpected host response');
      return response.review;
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
