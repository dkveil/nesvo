import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import {
  hostMessageSchema,
  hostRequestSchema,
  type ListPullRequestsInput,
  type ReadPullRequestInput,
  type ActOnPullRequestInput,
  type LinkSessionPullRequestInput,
  type FindSessionPullRequestInput,
  type CreateSessionInput,
  type ReadSessionWorktreeInput,
  type FinishSessionWorktreeInput,
  type DecideDelegationInput,
  type DecideWorkerPlanInput,
  type DecideReviewInput,
  type DesktopEvent,
  type AssignSessionWorkflowInput,
  type ForkSessionInput,
  type RestartSessionInput,
  type CompactSessionInput,
  type CreateSessionGroupInput,
  type MoveSessionInput,
  type SendMessageInput,
  type QueuedMessageRefInput,
  type RespondApprovalInput,
  type StopRunInput,
  type HostRequest,
  type HostResponse,
  type ListWorkspaceDirectoryInput,
  type SearchWorkspaceFilesInput,
  type ReadWorkspaceFileInput,
  type DiscoverSkillsInput,
  type ListClaudeCommandsInput,
  type ListMcpServersInput,
  type SetSessionMcpInput,
} from '@nesvo/contracts';
import { log, writeHostOutput } from './logging';
import { requestTimeoutMs } from './request-timeouts';

export function startHost(directory: string, workLaptopMode: boolean) {
  const child = utilityProcess.fork(
    join(import.meta.dirname, 'host-entry.js'),
    [],
    {
      serviceName: 'Nesvo Host',
      env: {
        ...process.env,
        NESVO_DATA_DIR: directory,
        ...(process.env.NESVO_DATA_DIR ? { NESVO_ISOLATED_PROFILE: '1' } : {}),
        NESVO_WORK_LAPTOP_MODE: workLaptopMode ? '1' : '0',
      },
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
    child.once('exit', (code: number) => {
      exited = true;
      log.warn(`The local host exited with code ${code}.`);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Host stopped'));
      }
      pending.clear();
      for (const listener of listeners) listener({ type: 'host-disconnected' });
      resolve();
    });
  });
  child.stderr?.on('data', (data: Buffer) => writeHostOutput('stderr', data));
  child.stdout?.on('data', (data: Buffer) => writeHostOutput('stdout', data));
  let droppedMessages = 0;
  child.on('message', (value: unknown) => {
    const parsed = hostMessageSchema.safeParse(value);
    if (!parsed.success) {
      droppedMessages += 1;
      log.warn(
        `Dropped an invalid local host message (${droppedMessages} so far).`,
      );
      return;
    }
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
        requestTimeoutMs(method, input),
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
    decideWorkerPlan: async (input: DecideWorkerPlanInput) => {
      const response = await request('decide-worker-plan', input);
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
    listClaudeCommands: async (input: ListClaudeCommandsInput) => {
      const response = await request('list-claude-commands', input);
      if (response.type !== 'claude-commands')
        throw new Error('Unexpected host response');
      return response.list;
    },
    listMcpServers: async (input: ListMcpServersInput) => {
      const response = await request('list-mcp-servers', input);
      if (response.type !== 'mcp-servers')
        throw new Error('Unexpected host response');
      return response.list;
    },
    setSessionMcp: async (input: SetSessionMcpInput) => {
      const response = await request('set-session-mcp', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
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
    listPullRequests: async (input: ListPullRequestsInput) => {
      const response = await request('list-pull-requests', input);
      if (response.type !== 'pull-request-list')
        throw new Error('Unexpected host response');
      return response.list;
    },
    readPullRequest: async (input: ReadPullRequestInput) => {
      const response = await request('read-pull-request', input);
      if (response.type !== 'pull-request')
        throw new Error('Unexpected host response');
      return response.pullRequest;
    },
    readPullRequestFiles: async (input: ReadPullRequestInput) => {
      const response = await request('read-pull-request-files', input);
      if (response.type !== 'pull-request-files')
        throw new Error('Unexpected host response');
      return response.files;
    },
    readPullRequestThreads: async (input: ReadPullRequestInput) => {
      const response = await request('read-pull-request-threads', input);
      if (response.type !== 'pull-request-threads')
        throw new Error('Unexpected host response');
      return response.threads;
    },
    actOnPullRequest: async (input: ActOnPullRequestInput) => {
      const response = await request('act-on-pull-request', input);
      if (response.type !== 'pull-request-action')
        throw new Error('Unexpected host response');
      return response.result;
    },
    linkSessionPullRequest: async (input: LinkSessionPullRequestInput) => {
      const response = await request('link-session-pull-request', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    findSessionPullRequest: async (input: FindSessionPullRequestInput) => {
      const response = await request('find-session-pull-request', input);
      if (response.type !== 'pull-request-reference')
        throw new Error('Unexpected host response');
      return response.reference;
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
    readSessionWorktree: async (input: ReadSessionWorktreeInput) => {
      const response = await request('read-session-worktree', input);
      if (response.type !== 'session-worktree-status')
        throw new Error('Unexpected host response');
      return response.worktree;
    },
    finishSessionWorktree: async (input: FinishSessionWorktreeInput) => {
      const response = await request('finish-session-worktree', input);
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
    assignSessionWorkflow: async (input: AssignSessionWorkflowInput) => {
      const response = await request('assign-session-workflow', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    forkSession: async (input: ForkSessionInput) => {
      const response = await request('fork-session', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    restartSession: async (input: RestartSessionInput) => {
      const response = await request('restart-session', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    compactSession: async (input: CompactSessionInput) => {
      const response = await request('compact-session', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    listSessionGroups: async () => {
      const response = await request('list-session-groups');
      if (response.type !== 'session-groups')
        throw new Error('Unexpected host response');
      return response.list;
    },
    createSessionGroup: async (input: CreateSessionGroupInput) => {
      const response = await request('create-session-group', input);
      if (response.type !== 'session-groups')
        throw new Error('Unexpected host response');
      return response.list;
    },
    moveSession: async (input: MoveSessionInput) => {
      const response = await request('move-session', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    queueMessage: async (input: SendMessageInput) => {
      const response = await request('queue-message', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    cancelQueued: async (input: QueuedMessageRefInput) => {
      const response = await request('cancel-queued', input);
      if (response.type !== 'session')
        throw new Error('Unexpected host response');
      return response.session;
    },
    startQueued: async (input: QueuedMessageRefInput) => {
      const response = await request('start-queued', input);
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
