import { workLaptopRestriction } from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import {
  type Computer,
  type DesktopEvent,
  type DesktopScheduledJob,
  type DesktopScheduledJobRun,
  type DesktopScheduledJobRunPage,
  type DesktopWorkflowRun,
  type DesktopWorkflowRunPage,
  type DesktopSession,
  type DesktopReview,
  type HostCapability,
  type HostHealth,
  type HostRequest,
  type HostResponse,
  type GetSessionInput,
  type ReadSessionMessagesInput,
  type SessionChange,
  type SessionMessagePage,
  type SessionWindow,
  type Review,
  type ScheduledJob,
  type WorkflowMethod,
  type SshComputerInput,
  type WorkspaceEvent,
  HOST_CONTRACT_REVISION,
  applySessionChange,
  isWorkflowMethod,
  prependSessionMessages,
  attachmentKind,
  sessionHistoryLimits,
  sshComputerInputSchema,
  trimSessionWindow,
  windowOffset,
} from '@nesvo/contracts';
import {
  IncompatibleHostError,
  isPermanentConnectionError,
} from './connection-errors';
import { EventBuffer } from './event-buffer';
import { type startHost } from './host-client';
import { log } from './logging';
import { connectSshHost } from './ssh-client';
import {
  ComputerStore,
  computerCacheSchema,
  computerConfigurationSchema,
  type CachedComputer,
} from './computer-store';

type ScheduledJobMethod = Extract<
  HostRequest['method'],
  `${string}scheduled-job${string}`
>;
type SessionWorkflowMethod = 'assign-session-workflow';
type SessionHistoryMethod = 'get-session' | 'read-session-messages';
export type CatalogWorkflowMethod = Exclude<
  WorkflowMethod,
  SessionWorkflowMethod
>;
type ExecutableMethod = Exclude<
  HostRequest['method'],
  | 'shutdown'
  | 'list-sessions'
  | SessionHistoryMethod
  | 'list-reviews'
  | ScheduledJobMethod
  | CatalogWorkflowMethod
>;
type Connection = {
  request: (
    method: HostRequest['method'],
    input?: unknown,
  ) => Promise<HostResponse>;
  subscribe: (listener: (event: DesktopEvent) => void) => () => void;
  close: () => Promise<void>;
};
type Entry = {
  computer: Computer;
  sessions: Map<string, SessionWindow>;
  recent: Map<string, SessionWindow>;
  reviews: Map<string, Review>;
  scheduledJobRevisions: Map<string, number>;
  workflowRunRevisions: Map<string, number>;
  workflowStepRevisions: Map<string, number>;
  generation: number;
  connection?: Connection;
  unsubscribe?: () => void;
  connecting?: Promise<Computer>;
  buffered?: EventBuffer;
  removing?: boolean;
  manualDisconnect?: boolean;
  recoveryAttempts: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  connectedAt?: number;
};

type LocalHost = ReturnType<typeof startHost>;

const RECENT_SESSION_WINDOWS = 8;
const OFFLINE_CACHE_BYTES = 16 * 1024 * 1024;
const LEGACY_OFFLINE_CACHE_BYTES = 64 * 1024 * 1024;

const sessionChange = (
  event: Extract<
    DesktopEvent,
    { type: 'session-changed' | 'session-message-upserted' }
  >,
): SessionChange =>
  event.type === 'session-changed'
    ? { type: 'snapshot', session: event.session }
    : { ...event, type: 'upsert' };

const LOCAL_RESTART_DELAYS_MS = [1000, 2000, 5000, 15_000];
const REMOTE_RECONNECT_DELAYS_MS = [2000, 5000, 15_000, 30_000, 60_000];
const STABLE_CONNECTION_MS = 60_000;

const newEntry = (computer: Computer): Entry => ({
  computer,
  sessions: new Map(),
  recent: new Map(),
  reviews: new Map(),
  scheduledJobRevisions: new Map(),
  workflowRunRevisions: new Map(),
  workflowStepRevisions: new Map(),
  generation: 0,
  recoveryAttempts: 0,
});

const contractMismatch = (health: HostHealth) => {
  const revision = health.contractRevision ?? 0;
  if (revision === HOST_CONTRACT_REVISION) return null;
  return revision < HOST_CONTRACT_REVISION
    ? 'This computer runs an older Nesvo host. Update its host, then reconnect.'
    : 'This computer runs a newer Nesvo host. Update Nesvo on this device, then reconnect.';
};

const pullRequestResponses = {
  'list-pull-requests': 'pull-request-list',
  'read-pull-request': 'pull-request',
  'read-pull-request-files': 'pull-request-files',
  'read-pull-request-threads': 'pull-request-threads',
  'act-on-pull-request': 'pull-request-action',
  'link-session-pull-request': 'session',
  'find-session-pull-request': 'pull-request-reference',
} as const;

const trackedRepositoryResponses = {
  'list-tracked-repositories': 'tracked-repositories',
  'add-tracked-repository': 'tracked-repositories',
  'remove-tracked-repository': 'tracked-repositories',
  'reorder-tracked-repositories': 'tracked-repositories',
  'suggest-tracked-repositories': 'tracked-repository-suggestions',
  'list-tracked-pull-requests': 'tracked-pull-request-lists',
} as const;

const worktreeRecipeResponses = {
  'list-worktree-recipes': 'worktree-recipes',
  'save-worktree-recipe': 'worktree-recipes',
  'delete-worktree-recipe': 'worktree-recipes',
  'match-worktree-recipe': 'worktree-recipe-match',
  'start-worktree-recipe-trial': 'worktree-recipe-trial',
  'read-worktree-recipe-trial': 'worktree-recipe-trial',
  'stop-worktree-recipe-trial': 'worktree-recipe-trial',
  'read-session-worktree-recipe': 'session-worktree-recipe',
  'decide-session-worktree-recipe': 'session-worktree-recipe',
} as const;

const codeReviewResponses = {
  'read-code-review-settings': 'code-review-settings',
  'save-reviewer-profile': 'code-review-settings',
  'delete-reviewer-profile': 'code-review-settings',
  'save-review-convention': 'code-review-settings',
  'delete-review-convention': 'code-review-settings',
  'start-pull-request-review': 'pull-request-review',
  'list-pull-request-reviews': 'pull-request-reviews',
  'update-review-finding': 'pull-request-review',
  'discard-pull-request-review': 'pull-request-review',
  'publish-pull-request-review': 'pull-request-review-publish',
} as const;

const sessionGroupResponses = {
  'list-session-groups': 'session-groups',
  'create-session-group': 'session-groups',
  'update-session-group': 'session-groups',
  'move-session-group': 'session-groups',
  'delete-session-group': 'session-groups',
  'move-session': 'session',
  'rename-session': 'session',
  'set-session-pinned': 'session',
  'set-session-archived': 'session',
} as const;

const sessionDeletionResponses = {
  'delete-session': 'session-deletion',
  'restore-session': 'session',
} as const;

const costResponses = {
  'read-costs': 'costs',
  'list-cost-budgets': 'cost-budgets',
  'create-cost-budget': 'cost-budget',
  'update-cost-budget': 'cost-budget',
  'delete-cost-budget': 'cost-budget-deleted',
} as const;

const capabilityUpdates: Record<HostCapability, string> = {
  'database-backup':
    'Update this computer’s Nesvo host and reconnect to back up its data.',
  'session-fork':
    'Update this computer’s Nesvo host and reconnect to fork or restart sessions.',
  costs:
    'Costs are unavailable on this computer. Update its Nesvo host, then reconnect.',
  'scheduled-jobs':
    'This computer runs an older Nesvo host without automations. Update it, then reconnect.',
  'scheduled-job-change-triggers':
    'Update this computer’s Nesvo host and reconnect to use automation change checks.',
  'reasoning-effort':
    'This computer runs an older Nesvo host without reasoning effort support. Update the host or start without an effort.',
  workflows:
    'Workflows are not available on this computer yet. Update its Nesvo host, then reconnect.',
  'permission-modes':
    'This computer runs an older Nesvo host without the new permission modes. Update the host, then reconnect.',
  'session-workflow':
    'This computer runs an older Nesvo host that cannot assign a workflow to a session. Update the host, then reconnect.',
  'pull-requests':
    'This computer runs an older Nesvo host without GitHub pull requests. Update the host, then reconnect.',
  'git-branch':
    'This computer runs an older Nesvo host that cannot read Git branches. Update the host to show the branch.',
  'conversation-import':
    'This computer runs an older Nesvo host without conversation import. Update the host, then reconnect.',
  'session-worktrees':
    'This computer runs an older Nesvo host without session worktrees. Update the host, then reconnect.',
  'session-worktree-tools':
    'Update this computer’s Nesvo host and reconnect to use worktree tools.',
  'history-search':
    'Update this computer’s Nesvo host and reconnect to search its history.',
  'session-groups':
    'This computer runs an older Nesvo host without session groups. Update the host, then reconnect.',
  'repository-mcp-trust':
    'Update this computer’s Nesvo host and reconnect to review repository MCP servers and hooks.',
  'mcp-servers':
    'This computer runs an older Nesvo host without MCP servers and hooks. Update the host, then reconnect.',
  'claude-approvals':
    'This computer runs an older Nesvo host that cannot answer Claude Code approvals. Update the host, then reconnect.',
  'message-attachments':
    'This computer runs an older Nesvo host that cannot receive images. Update the host, then reconnect.',
  'inline-attachments':
    'Update this computer’s Nesvo host and reconnect to place images inside the message text.',
  'file-attachments':
    'Update this computer’s Nesvo host and reconnect to attach files other than images.',
  'session-changes':
    'Update this computer’s Nesvo host and reconnect to review the session changes.',
  'code-comments':
    'Update this computer’s Nesvo host and reconnect to send code comments to the agent.',
  'terminal-handoff':
    'Update this computer’s Nesvo host and reconnect to open its sessions in a terminal.',
  'transcript-search':
    'Update this computer’s Nesvo host and reconnect to search its CLI transcripts.',
  'session-delete':
    'Update this computer’s Nesvo host and reconnect to delete sessions.',
  'conversation-compaction':
    'This computer runs an older Nesvo host that cannot compact conversations. Update the host, then reconnect.',
  'provider-profiles':
    'Update this computer’s Nesvo host and reconnect to use provider accounts.',
  'pull-request-reviews':
    'Update this computer’s Nesvo host and reconnect to review pull requests with an agent.',
  'tracked-repositories':
    'Update this computer’s Nesvo host and reconnect to track repositories.',
  'running-apps':
    'Update this computer’s Nesvo host and reconnect to see running apps.',
  'default-session-folder':
    'Update this computer’s Nesvo host and reconnect to set a default session folder.',
  'worktree-recipes':
    'Update this computer’s Nesvo host and reconnect to use worktree recipes.',
  'session-control':
    'Update this computer’s Nesvo host and reconnect to let sessions coordinate other sessions.',
};

const hasFileAttachments = (input: unknown) =>
  typeof input === 'object' &&
  input !== null &&
  'attachments' in input &&
  Array.isArray(input.attachments) &&
  input.attachments.some(
    attachment =>
      typeof attachment === 'object' &&
      attachment !== null &&
      'mediaType' in attachment &&
      typeof attachment.mediaType === 'string' &&
      attachmentKind(attachment.mediaType) !== 'image',
  );

function requiredCapability(
  method: HostRequest['method'],
  input: unknown,
): HostCapability | null {
  if (
    method.endsWith('-provider-profiles') ||
    method.endsWith('-provider-profile')
  )
    return 'provider-profiles';
  if (Object.hasOwn(costResponses, method)) return 'costs';
  if (Object.hasOwn(trackedRepositoryResponses, method))
    return 'tracked-repositories';
  if (Object.hasOwn(worktreeRecipeResponses, method)) return 'worktree-recipes';
  if (Object.hasOwn(codeReviewResponses, method)) return 'pull-request-reviews';
  if (
    method === 'act-on-pull-request' &&
    typeof input === 'object' &&
    input !== null &&
    'action' in input &&
    typeof input.action === 'object' &&
    input.action !== null &&
    'action' in input.action &&
    input.action.action === 'submit-review'
  )
    return 'pull-request-reviews';
  if (Object.hasOwn(pullRequestResponses, method)) return 'pull-requests';
  if (method === 'read-git-branch') return 'git-branch';
  if (method === 'list-running-apps') return 'running-apps';
  if (
    method === 'read-default-session-folder' ||
    method === 'set-default-session-folder'
  )
    return 'default-session-folder';
  if (
    method === 'read-session-control-policy' ||
    method === 'save-session-control-policy' ||
    method === 'decide-session-parent'
  )
    return 'session-control';
  if (
    method === 'read-session-changes' ||
    method === 'read-session-change-patch'
  )
    return 'session-changes';
  if (
    (method === 'send-message' || method === 'queue-message') &&
    typeof input === 'object' &&
    input !== null &&
    'codeComments' in input &&
    input.codeComments
  )
    return 'code-comments';
  if (
    method === 'read-session-worktree-setup' ||
    method === 'run-session-worktree-setup' ||
    method === 'list-orphaned-session-worktrees' ||
    method === 'remove-orphaned-session-worktree' ||
    (method === 'fork-session' &&
      typeof input === 'object' &&
      input !== null &&
      'worktree' in input &&
      input.worktree)
  )
    return 'session-worktree-tools';
  if (
    method === 'read-session-worktree' ||
    method === 'finish-session-worktree'
  )
    return 'session-worktrees';
  if (
    method === 'create-session' &&
    typeof input === 'object' &&
    input !== null &&
    'isolation' in input &&
    input.isolation
  )
    return 'session-worktrees';
  if (method === 'search-history') return 'history-search';
  if (method === 'search-transcripts') return 'transcript-search';
  if (method === 'set-session-terminal') return 'terminal-handoff';
  if (method === 'list-conversations' || method === 'adopt-conversation')
    return 'conversation-import';
  if (Object.hasOwn(sessionDeletionResponses, method)) return 'session-delete';
  if (Object.hasOwn(sessionGroupResponses, method)) return 'session-groups';
  if (
    method === 'create-session' &&
    typeof input === 'object' &&
    input !== null &&
    'groupId' in input &&
    input.groupId
  )
    return 'session-groups';
  if (method === 'assign-session-workflow') return 'session-workflow';
  if (method === 'fork-session' || method === 'restart-session')
    return 'session-fork';
  if (method === 'backup-database') return 'database-backup';
  if (method === 'compact-session') return 'conversation-compaction';
  if (
    method === 'locate-attachment' ||
    ((method === 'send-message' || method === 'queue-message') &&
      hasFileAttachments(input))
  )
    return 'file-attachments';
  if (
    method === 'stage-attachment' ||
    method === 'read-attachment' ||
    ((method === 'send-message' || method === 'queue-message') &&
      typeof input === 'object' &&
      input !== null &&
      'attachments' in input &&
      input.attachments)
  )
    return 'message-attachments';
  if (method === 'trust-repository-mcp') return 'repository-mcp-trust';
  if (method === 'list-mcp-servers' || method === 'set-session-mcp')
    return 'mcp-servers';
  if (
    method === 'create-session' &&
    typeof input === 'object' &&
    input !== null &&
    'mcp' in input &&
    input.mcp
  )
    return 'mcp-servers';
  if (
    method === 'list-workflow-definitions' ||
    method === 'validate-workflow-definitions'
  )
    return null;
  if (isWorkflowMethod(method)) return 'workflows';
  if (
    method === 'create-session' &&
    typeof input === 'object' &&
    input !== null &&
    'effort' in input &&
    input.effort
  )
    return 'reasoning-effort';
  if (
    method === 'respond-approval' &&
    typeof input === 'object' &&
    input !== null &&
    (('fingerprint' in input && input.fingerprint) ||
      ('message' in input && input.message))
  )
    return 'claude-approvals';
  return null;
}

export class ComputerManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private readonly store: ComputerStore;
  private configurationError = '';
  private cacheTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private readonly loaded: Promise<void>;
  private resolveLoaded!: () => void;

  constructor(
    directory: string,
    private readonly startLocal: () => LocalHost,
    private readonly workLaptopMode: boolean,
  ) {
    this.store = new ComputerStore(directory);
    this.loaded = new Promise(resolve => {
      this.resolveLoaded = resolve;
    });
    this.entries.set(
      'local',
      newEntry({
        id: 'local',
        name: 'Local',
        kind: 'local',
        status: 'connecting',
        instanceId: null,
        lastSyncedAt: null,
        error: null,
        capabilities: [],
      }),
    );
  }

  async initialize() {
    try {
      if (!this.workLaptopMode) await this.loadSavedComputers();
    } finally {
      this.resolveLoaded();
    }
    this.publishComputers();
    for (const entry of this.entries.values())
      if (entry.computer.kind === 'ssh') {
        if (entry.sessions.size > 0 || entry.reviews.size > 0)
          this.publish({
            type: 'host-snapshot',
            hostId: entry.computer.id,
            sessions: this.listSessions(entry.computer.id),
            reviews: this.listReviews(entry.computer.id),
          });
        void this.recover(entry);
      }
    await this.recover(this.get('local'));
  }

  resume() {
    if (this.closing) return;
    log.info('The system resumed; refreshing computer connections.');
    for (const entry of this.entries.values()) {
      if (entry.removing || entry.manualDisconnect) continue;
      clearTimeout(entry.recoveryTimer);
      entry.recoveryTimer = undefined;
      entry.recoveryAttempts = 0;
      const { status } = entry.computer;
      if (status === 'connected') {
        if (entry.computer.kind === 'ssh') void this.probe(entry);
      } else if (status === 'error' || status === 'disconnected')
        void this.recover(entry);
    }
  }

  private async probe(entry: Entry) {
    const connection = entry.connection;
    const generation = entry.generation;
    try {
      await connection?.request('health');
    } catch {
      if (!this.current(entry, generation) || entry.connection !== connection)
        return;
      log.warn(
        `${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} did not answer after the system resumed.`,
      );
      await connection?.close().catch(() => undefined);
    }
  }

  private async loadSavedComputers() {
    try {
      const raw = await this.store.read('computers.json', 512 * 1024);
      const saved =
        raw === undefined
          ? []
          : computerConfigurationSchema.parse(raw).computers;
      for (const computer of saved)
        this.entries.set(
          computer.id,
          newEntry({
            id: computer.id,
            name: computer.input.name,
            kind: 'ssh',
            ssh: computer.input,
            instanceId: computer.instanceId,
            status: 'disconnected',
            lastSyncedAt: null,
            error: null,
            capabilities: [],
          }),
        );
    } catch {
      log.error('Saved computers could not be read.');
      this.configurationError =
        'Saved computers could not be read. Restore computers.json before changing the list.';
    }
    try {
      const raw = await this.store.read(
        'computer-cache.json',
        LEGACY_OFFLINE_CACHE_BYTES,
      );
      for (const cache of raw === undefined
        ? []
        : computerCacheSchema.parse(raw).computers) {
        const entry = this.entries.get(cache.id);
        if (!entry || entry.computer.instanceId !== cache.instanceId) continue;
        entry.sessions = new Map(
          cache.sessions.map(session => [
            session.id,
            trimSessionWindow(session),
          ]),
        );
        entry.recent = new Map(
          cache.recent.map(session => [session.id, session]),
        );
        entry.reviews = new Map(
          cache.reviews.map(review => [review.id, review]),
        );
        entry.computer.lastSyncedAt = cache.lastSyncedAt;
      }
    } catch {
      log.error('Offline history could not be read.');
      for (const entry of this.entries.values())
        if (entry.computer.kind === 'ssh')
          entry.computer.error =
            'Offline history could not be read. Connect to load it from this computer.';
    }
  }

  private connectEntry(entry: Entry): Promise<Computer> {
    if (entry.removing)
      return Promise.reject(new Error('This computer is being removed.'));
    if (this.closing) return Promise.reject(new Error('Nesvo is closing.'));
    if (entry.computer.status === 'connected')
      return Promise.resolve({ ...entry.computer });
    if (entry.connecting) return entry.connecting;
    const generation = ++entry.generation;
    const operation = entry.computer.ssh
      ? this.openRemote(entry, generation)
      : this.openLocal(entry, generation);
    entry.connecting = operation;
    void operation
      .finally(() => {
        if (entry.connecting === operation) entry.connecting = undefined;
      })
      .catch(() => undefined);
    return operation;
  }

  private async recover(entry: Entry) {
    if (
      this.closing ||
      entry.removing ||
      entry.manualDisconnect ||
      this.entries.get(entry.computer.id) !== entry
    )
      return;
    try {
      await this.connectEntry(entry);
    } catch (error) {
      if (isPermanentConnectionError(error)) {
        log.warn(
          `${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} needs attention.`,
        );
        return;
      }
      this.scheduleRecovery(entry);
    }
  }

  private scheduleRecovery(entry: Entry) {
    if (
      this.closing ||
      entry.removing ||
      entry.manualDisconnect ||
      entry.recoveryTimer ||
      entry.computer.status === 'incompatible' ||
      this.entries.get(entry.computer.id) !== entry
    )
      return;
    if (
      entry.connectedAt &&
      Date.now() - entry.connectedAt >= STABLE_CONNECTION_MS
    )
      entry.recoveryAttempts = 0;
    entry.connectedAt = undefined;
    const local = entry.computer.kind === 'local';
    const delays = local ? LOCAL_RESTART_DELAYS_MS : REMOTE_RECONNECT_DELAYS_MS;
    const delay = delays[entry.recoveryAttempts];
    if (delay === undefined) {
      entry.computer.status = 'error';
      entry.computer.error = local
        ? 'The local host stopped and could not be restarted. Select Retry, or open the logs from Settings.'
        : 'Nesvo could not reconnect to this computer and stopped retrying. Select Connect to try again.';
      log.error(
        `Gave up reconnecting ${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} after ${delays.length} attempts.`,
      );
      this.publishComputers();
      return;
    }
    entry.recoveryAttempts += 1;
    log.warn(
      `Reconnecting ${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} in ${delay} ms (attempt ${entry.recoveryAttempts} of ${delays.length}).`,
    );
    entry.recoveryTimer = setTimeout(() => {
      entry.recoveryTimer = undefined;
      void this.recover(entry);
    }, delay);
  }

  private async openLocal(entry: Entry, generation: number) {
    entry.computer.status = 'connecting';
    this.publishComputers();
    this.detach(entry);
    const previous = entry.connection;
    entry.connection = undefined;
    await previous?.close().catch(() => undefined);
    if (!this.current(entry, generation))
      throw new Error('Connection cancelled.');
    const host = this.startLocal();
    entry.connection = {
      request: host.request,
      subscribe: host.subscribe,
      close: host.stop,
    };
    this.listen(entry, generation);
    try {
      const health = await host.health();
      await this.synchronize(entry, generation, health);
      if (this.configurationError)
        entry.computer.error = this.configurationError;
      return { ...entry.computer };
    } catch (error) {
      if (this.current(entry, generation)) {
        this.detach(entry);
        entry.connection = undefined;
        this.fail(entry, error);
      }
      await host.stop().catch(() => undefined);
      throw error;
    }
  }

  subscribe(listener: (event: WorkspaceEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listComputers() {
    return [...this.entries.values()].map(entry => ({ ...entry.computer }));
  }

  listSessions(hostId?: string): DesktopSession[] {
    return this.selected(hostId).flatMap(entry =>
      [...entry.sessions.values()].map(session => ({
        ...session,
        hostId: entry.computer.id,
      })),
    );
  }

  listReviews(hostId?: string): DesktopReview[] {
    return this.selected(hostId).flatMap(entry =>
      [...entry.reviews.values()].map(review => ({
        ...review,
        hostId: entry.computer.id,
      })),
    );
  }

  async addComputer(input: SshComputerInput) {
    if (this.workLaptopMode) throw new Error(workLaptopRestriction);
    await this.loaded;
    if (this.closing) throw new Error('Nesvo is closing.');
    if (this.entries.size >= 9)
      throw new Error('This prototype supports up to eight remote computers.');
    const target = sshComputerInputSchema.parse(input);
    const id = randomUUID();
    const entry = newEntry({
      id,
      name: target.name,
      kind: 'ssh',
      ssh: target,
      status: 'disconnected',
      instanceId: null,
      lastSyncedAt: null,
      error: null,
      capabilities: [],
    });
    this.entries.set(id, entry);
    try {
      await this.persistConfiguration();
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
    this.publishComputers();
    return { ...entry.computer };
  }

  async connectComputer(hostId: string): Promise<Computer> {
    await this.loaded;
    const entry = this.get(hostId);
    entry.manualDisconnect = false;
    clearTimeout(entry.recoveryTimer);
    entry.recoveryTimer = undefined;
    entry.recoveryAttempts = 0;
    return this.connectEntry(entry);
  }

  private async openRemote(entry: Entry, generation: number) {
    entry.computer.status = 'connecting';
    entry.computer.error = null;
    this.publishComputers();
    const previous = entry.connection;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    try {
      await previous?.close();
    } catch (error) {
      if (this.current(entry, generation)) {
        entry.computer.status = 'error';
        entry.computer.error = this.describe(error);
        this.publishComputers();
      }
      throw error;
    }
    if (entry.connection === previous) entry.connection = undefined;
    if (!this.current(entry, generation))
      throw new Error('Connection cancelled.');
    let client: ReturnType<typeof connectSshHost>;
    try {
      client = connectSshHost(
        entry.computer.ssh!,
        entry.computer.instanceId ?? undefined,
      );
    } catch (error) {
      this.fail(entry, error);
      throw error;
    }
    const connection: Connection = {
      request: client.request,
      subscribe: client.subscribe,
      close: client.disconnect,
    };
    entry.connection = connection;
    this.listen(entry, generation);
    try {
      const health = await client.ready;
      if (!this.current(entry, generation))
        throw new Error('Connection cancelled.');
      this.verifyContract(health);
      const previousPin = entry.computer.instanceId;
      entry.computer.instanceId = health.instanceId;
      try {
        await this.persistConfiguration();
      } catch (error) {
        if (this.current(entry, generation))
          entry.computer.instanceId = previousPin;
        throw error;
      }
      await this.synchronize(entry, generation, health);
      return { ...entry.computer };
    } catch (error) {
      if (this.current(entry, generation)) {
        this.detach(entry);
        entry.connection = undefined;
        this.fail(entry, error);
      }
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  private verifyContract(health: HostHealth) {
    const mismatch = contractMismatch(health);
    if (mismatch) throw new IncompatibleHostError(mismatch);
  }

  private fail(entry: Entry, error: unknown) {
    entry.computer.status =
      error instanceof IncompatibleHostError ? 'incompatible' : 'error';
    entry.computer.error = this.describe(error);
    entry.buffered = undefined;
    log.warn(
      `${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} connection failed.`,
    );
    this.publishComputers();
  }

  async disconnectComputer(hostId: string) {
    const entry = this.get(hostId);
    if (hostId === 'local')
      throw new Error('The local host is managed by Nesvo.');
    ++entry.generation;
    entry.manualDisconnect = true;
    clearTimeout(entry.recoveryTimer);
    entry.recoveryTimer = undefined;
    entry.connecting = undefined;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    const connection = entry.connection;
    entry.connection = undefined;
    entry.buffered = undefined;
    entry.computer.status = 'disconnected';
    entry.computer.error = null;
    this.publishComputers();
    await connection?.close();
    await this.saveOfflineCache();
    return { ...entry.computer };
  }

  async removeComputer(hostId: string) {
    await this.loaded;
    const entry = this.get(hostId);
    if (hostId === 'local')
      throw new Error('The local computer cannot be removed.');
    if (entry.removing)
      throw new Error('This computer is already being removed.');
    entry.removing = true;
    try {
      await this.disconnectComputer(hostId);
      this.entries.delete(hostId);
      await this.persistConfiguration();
    } catch (error) {
      this.entries.set(hostId, entry);
      entry.removing = false;
      this.publishComputers();
      throw error;
    }
    this.publish({ type: 'host-snapshot', hostId, sessions: [], reviews: [] });
    this.publishComputers();
    await this.saveOfflineCache();
  }

  private async dispatch(
    method:
      | ExecutableMethod
      | ScheduledJobMethod
      | WorkflowMethod
      | SessionHistoryMethod,
    input: unknown,
    hostId: string,
    requires?: HostCapability,
  ) {
    const entry = this.get(hostId);
    if (
      entry.computer.status !== 'connected' ||
      !entry.connection ||
      this.closing
    )
      throw new Error(
        'This computer is offline or still synchronizing. Connect before sending a command.',
      );
    if (
      method === 'list-conversations' &&
      input &&
      typeof input === 'object' &&
      'provider' in input &&
      input.provider !== undefined &&
      !entry.computer.capabilities.includes('provider-profiles')
    )
      throw new Error(capabilityUpdates['provider-profiles']);
    if (
      input &&
      typeof input === 'object' &&
      (('profileId' in input && typeof input.profileId === 'string') ||
        ('defaults' in input &&
          input.defaults &&
          typeof input.defaults === 'object' &&
          'profileId' in input.defaults &&
          input.defaults.profileId !== undefined)) &&
      !entry.computer.capabilities.includes('provider-profiles')
    )
      throw new Error(capabilityUpdates['provider-profiles']);
    const capability = requires ?? requiredCapability(method, input);
    if (capability && !entry.computer.capabilities.includes(capability))
      throw new Error(capabilityUpdates[capability]);
    const generation = entry.generation;
    const response = await entry.connection.request(method, input);
    if (
      !this.current(entry, generation) ||
      entry.computer.status !== 'connected'
    )
      throw new Error(
        'The connection changed before the response arrived. Refresh its state before retrying.',
      );
    return { entry, response };
  }

  async executeScheduledJob(
    method: ScheduledJobMethod,
    input: unknown,
    hostId: string,
  ) {
    const needsReviews =
      method === 'save-scheduled-job' &&
      typeof input === 'object' &&
      input !== null &&
      'pullRequestReview' in input &&
      !!input.pullRequestReview;
    const needsChangeTriggers =
      method === 'decide-scheduled-job-start' ||
      (method === 'save-scheduled-job' &&
        typeof input === 'object' &&
        input !== null &&
        'changeTrigger' in input &&
        !!input.changeTrigger);
    const { entry, response } = await this.dispatch(
      method,
      input,
      hostId,
      needsReviews
        ? 'pull-request-reviews'
        : needsChangeTriggers
          ? 'scheduled-job-change-triggers'
          : 'scheduled-jobs',
    );
    const expected = {
      'list-scheduled-jobs': 'scheduled-jobs',
      'save-scheduled-job': 'scheduled-job',
      'set-scheduled-job-active': 'scheduled-job',
      'delete-scheduled-job': 'scheduled-job-deleted',
      'list-scheduled-job-runs': 'scheduled-job-runs',
      'run-scheduled-job-now': 'scheduled-job-run',
      'decide-scheduled-job-start': 'scheduled-job',
    }[method];
    if (response.type !== expected)
      throw new Error('Unexpected host response.');
    switch (response.type) {
      case 'scheduled-jobs':
        return response.list.scheduledJobs.map(
          (scheduledJob): DesktopScheduledJob => {
            this.rememberScheduledJob(entry, scheduledJob);
            return { ...scheduledJob, hostId };
          },
        );
      case 'scheduled-job':
        this.apply(entry, {
          type: 'scheduled-job-changed',
          scheduledJob: response.scheduledJob,
        });
        return { ...response.scheduledJob, hostId };
      case 'scheduled-job-deleted':
        entry.scheduledJobRevisions.delete(response.scheduledJobId);
        return undefined;
      case 'scheduled-job-runs':
        return {
          ...response.page,
          runs: response.page.runs.map((run): DesktopScheduledJobRun => ({
            ...run,
            hostId,
          })),
        } satisfies DesktopScheduledJobRunPage;
      case 'scheduled-job-run':
        return { ...response.run, hostId };
      default:
        throw new Error('Unexpected host response.');
    }
  }

  async executeWorkflow(
    method: CatalogWorkflowMethod,
    input: unknown,
    hostId: string,
  ) {
    const { entry, response } = await this.dispatch(method, input, hostId);
    const expected = {
      'list-workflow-definitions': 'workflow-definitions',
      'validate-workflow-definitions': 'workflow-definitions',
      'save-workflow-definition': 'workflow-definitions',
      'delete-workflow-definition': 'workflow-definitions',
      'start-workflow-task': 'workflow-run',
      'run-workflow-steps': 'workflow-run',
      'decide-workflow-gate': 'workflow-run',
      'skip-workflow-step': 'workflow-run',
      'resume-workflow-run': 'workflow-run',
      'resolve-workflow-step': 'workflow-run',
      'stop-workflow-run': 'workflow-run',
      'remove-workflow-worktree': 'workflow-run',
      'list-workflow-runs': 'workflow-runs',
      'get-workflow-run': 'workflow-run-detail',
      'read-workflow-evidence': 'workflow-evidence',
      'workflow-metrics': 'workflow-metrics',
      'workflow-assistant-send': 'workflow-assistant-turn',
      'workflow-assistant-undo': 'workflow-assistant-undo',
      'workflow-assistant-changes': 'workflow-assistant-changes',
    }[method];
    const definitionWrite =
      (method === 'save-workflow-definition' ||
        method === 'delete-workflow-definition') &&
      (response.type === 'workflow-definition-conflict' ||
        response.type === 'workflow-definition-refused');
    if (response.type !== expected && !definitionWrite)
      throw new Error('Unexpected host response.');
    switch (response.type) {
      case 'workflow-definitions':
        return response.catalog;
      case 'workflow-definition-conflict':
      case 'workflow-definition-refused':
        return Object.fromEntries(
          Object.entries(response).filter(([key]) => key !== 'id'),
        );
      case 'workflow-run':
        this.apply(entry, { type: 'workflow-run-changed', run: response.run });
        return { ...response.run, hostId } satisfies DesktopWorkflowRun;
      case 'workflow-runs':
        return {
          ...response.page,
          runs: response.page.runs.map(run => ({ ...run, hostId })),
        } satisfies DesktopWorkflowRunPage;
      case 'workflow-run-detail':
        return {
          run: { ...response.detail.run, hostId },
          steps: response.detail.steps.map(step => ({ ...step, hostId })),
        };
      case 'workflow-evidence':
        return response.evidence;
      case 'workflow-metrics':
        return response.metrics;
      case 'workflow-assistant-turn':
        return response.turn;
      case 'workflow-assistant-undo':
        return response.result;
      case 'workflow-assistant-changes':
        return response.history;
      default:
        throw new Error('Unexpected host response.');
    }
  }

  async execute(method: ExecutableMethod, input: unknown, hostId = 'local') {
    const { entry, response } = await this.dispatch(method, input, hostId);
    const expected = {
      health: 'health',
      'claude-status': 'claude-status',
      'codex-status': 'codex-status',
      'provider-usage': 'provider-usage',
      'list-provider-profiles': 'provider-profiles',
      'create-provider-profile': 'provider-profiles',
      'rename-provider-profile': 'provider-profiles',
      'remove-provider-profile': 'provider-profiles',
      'create-session': 'session',
      'read-session-worktree': 'session-worktree-status',
      'finish-session-worktree': 'session',
      'read-session-worktree-setup': 'session-worktree-setup',
      'run-session-worktree-setup': 'session-worktree-setup-result',
      'list-orphaned-session-worktrees': 'orphaned-session-worktrees',
      'remove-orphaned-session-worktree': 'orphaned-session-worktree-removal',
      'send-message': 'session',
      'assign-session-workflow': 'session',
      'fork-session': 'session',
      'restart-session': 'session',
      'compact-session': 'session',
      'set-session-mcp': 'session',
      'list-mcp-servers': 'mcp-servers',
      'trust-repository-mcp': 'mcp-servers',
      'queue-message': 'session',
      'cancel-queued': 'session',
      'start-queued': 'session',
      'stop-run': 'session',
      'respond-approval': 'session',
      'decide-delegation': 'session',
      'decide-worker-plan': 'session',
      'decide-session-parent': 'session',
      'read-session-control-policy': 'session-control-policy',
      'save-session-control-policy': 'session-control-policy',
      'decide-review': 'review',
      'discover-skills': 'skills',
      'list-workspace-directory': 'workspace-directory',
      'search-workspace-files': 'workspace-search',
      'read-workspace-file': 'workspace-file',
      'stage-attachment': 'attachment-upload',
      'read-attachment': 'attachment-content',
      'locate-attachment': 'attachment-location',
      'read-git-branch': 'git-branch',
      'read-session-changes': 'session-changes',
      'read-session-change-patch': 'session-change-patch',
      'search-history': 'history-search',
      'search-transcripts': 'transcript-search',
      'set-session-terminal': 'session',
      'list-conversations': 'conversation-import-catalog',
      'adopt-conversation': 'session',
      'get-transcript-retention': 'transcript-retention',
      'set-transcript-retention': 'transcript-retention',
      'purge-transcripts': 'transcript-retention',
      'backup-database': 'database-backup',
      'list-running-apps': 'running-apps',
      'read-default-session-folder': 'default-session-folder',
      'set-default-session-folder': 'default-session-folder',
      ...sessionGroupResponses,
      ...sessionDeletionResponses,
      ...pullRequestResponses,
      ...trackedRepositoryResponses,
      ...worktreeRecipeResponses,
      ...codeReviewResponses,
      ...costResponses,
    }[method];
    if (response.type !== expected)
      throw new Error('Unexpected host response.');
    switch (response.type) {
      case 'costs':
        return response.report;
      case 'cost-budgets':
        return response.list;
      case 'cost-budget':
        return response.budget;
      case 'cost-budget-deleted':
        return response.deleted;
      case 'provider-profiles':
        return response.profiles;
      case 'provider-usage':
        return response.usage;
      case 'health':
        return response.health;
      case 'claude-status':
      case 'codex-status':
        return response.status;
      case 'skills':
        return response.catalog;
      case 'mcp-servers':
        return response.list;
      case 'transcript-retention':
        return response.retention;
      case 'database-backup':
        return response.backup;
      case 'workspace-directory':
        return response.directory;
      case 'workspace-search':
        return response.search;
      case 'workspace-file':
        return response.file;
      case 'attachment-upload':
        return response.upload;
      case 'attachment-content':
        return response.content;
      case 'attachment-location':
        return response.location;
      case 'pull-request-list':
        return response.list;
      case 'pull-request':
        return response.pullRequest;
      case 'pull-request-files':
        return response.files;
      case 'pull-request-threads':
        return response.threads;
      case 'pull-request-action':
        return response.result;
      case 'pull-request-reference':
        return response.reference;
      case 'tracked-repositories':
        return response.repositories;
      case 'running-apps':
        return response.list;
      case 'default-session-folder':
        return response.directory;
      case 'worktree-recipes':
        return response.recipes;
      case 'worktree-recipe-match':
        return response.match;
      case 'worktree-recipe-trial':
        return response.trial;
      case 'session-worktree-recipe':
        return response.run;
      case 'session-control-policy':
        return response.policy;
      case 'tracked-repository-suggestions':
        return response.suggestions;
      case 'tracked-pull-request-lists':
        return response.lists;
      case 'code-review-settings':
        return response.settings;
      case 'pull-request-review':
        this.apply(entry, {
          type: 'pull-request-review-changed',
          draft: response.draft,
        });
        return { ...response.draft, hostId };
      case 'pull-request-reviews':
        return response.drafts.map(draft => ({ ...draft, hostId }));
      case 'pull-request-review-publish':
        this.apply(entry, {
          type: 'pull-request-review-changed',
          draft: response.result.draft,
        });
        return {
          ...response.result,
          draft: { ...response.result.draft, hostId },
        };
      case 'git-branch':
        return response.branch;
      case 'session-changes':
        return response.changes;
      case 'session-change-patch':
        return response.patch;
      case 'conversation-import-catalog':
        return response.catalog;
      case 'session-worktree-status':
        return response.worktree;
      case 'session-worktree-setup':
        return response.setup;
      case 'session-worktree-setup-result':
        return response.result;
      case 'orphaned-session-worktrees':
        return response.worktrees;
      case 'orphaned-session-worktree-removal':
        return response.removal;
      case 'history-search':
      case 'transcript-search':
        return response.search;
      case 'session-groups':
        return response.list;
      case 'session-deletion':
        this.apply(entry, {
          type: 'sessions-removed',
          sessionIds: response.deletion.sessionIds,
        });
        return { ...response.deletion, hostId };
      case 'session':
        this.apply(entry, {
          type: 'session-changed',
          session: response.session,
        });
        return { ...response.session, hostId };
      case 'review':
        this.apply(entry, { type: 'review-changed', review: response.review });
        return { ...response.review, hostId };
      default:
        throw new Error('Unexpected host response.');
    }
  }

  async close() {
    this.closing = true;
    await this.loaded;
    clearTimeout(this.cacheTimer);
    for (const entry of this.entries.values())
      clearTimeout(entry.recoveryTimer);
    await this.persistCache().catch(() => undefined);
    await Promise.allSettled(
      [...this.entries.values()].map(async entry => {
        ++entry.generation;
        entry.unsubscribe?.();
        await entry.connection?.close();
        await entry.connecting;
      }),
    );
  }

  private get(hostId: string) {
    if (this.workLaptopMode && hostId !== 'local')
      throw new Error(workLaptopRestriction);
    const entry = this.entries.get(hostId);
    if (!entry) throw new Error('Computer not found.');
    return entry;
  }
  private selected(hostId?: string) {
    return hostId === undefined
      ? [...this.entries.values()]
      : [this.get(hostId)];
  }
  private current(entry: Entry, generation: number) {
    return (
      !this.closing &&
      this.entries.get(entry.computer.id) === entry &&
      entry.generation === generation
    );
  }
  private detach(entry: Entry) {
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
  }
  private failed(entry: Entry) {
    return entry.computer.status === 'error';
  }
  private describe(error: unknown) {
    return (
      error instanceof Error ? error.message : 'The host connection failed.'
    ).slice(0, 2000);
  }
  private publish(event: WorkspaceEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private publishComputers() {
    this.publish({
      type: 'computers-changed',
      computers: this.listComputers(),
    });
  }

  private listen(entry: Entry, generation: number) {
    entry.buffered = new EventBuffer();
    entry.unsubscribe = entry.connection!.subscribe(event => {
      if (!this.current(entry, generation)) return;
      if (event.type === 'host-disconnected') {
        const dropped = entry.computer.status === 'connected';
        entry.computer.status = 'error';
        entry.computer.error =
          entry.computer.kind === 'local'
            ? 'The local host stopped. Nesvo is restarting it.'
            : 'Connection lost. Work on this computer may still be running. Nesvo is reconnecting.';
        entry.buffered = undefined;
        log.warn(
          `${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} disconnected.`,
        );
        this.publish({ type: 'host-disconnected', hostId: entry.computer.id });
        this.publishComputers();
        if (dropped) this.scheduleRecovery(entry);
        return;
      }
      if (!entry.buffered) {
        this.apply(entry, event);
        return;
      }
      if (entry.buffered.add(event)) return;
      entry.computer.status = 'error';
      entry.computer.error =
        'Too many changes arrived while synchronizing. Nesvo is reconnecting.';
      entry.buffered = undefined;
      log.warn(
        `${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} exceeded the synchronization buffer.`,
      );
      void entry.connection?.close().catch(() => undefined);
      this.publishComputers();
    });
  }

  private async synchronize(
    entry: Entry,
    generation: number,
    health: HostHealth,
  ) {
    if (!this.current(entry, generation) || this.failed(entry))
      throw new Error('Connection lost while synchronizing.');
    this.verifyContract(health);
    entry.computer.status = 'syncing';
    this.publishComputers();
    const [sessions, reviews] = await Promise.all([
      entry.connection!.request('list-sessions'),
      entry.connection!.request('list-reviews'),
    ]);
    if (!this.current(entry, generation) || this.failed(entry))
      throw new Error('Connection lost while synchronizing.');
    if (sessions.type !== 'sessions' || reviews.type !== 'reviews')
      throw new Error('Invalid host history.');
    entry.sessions = new Map(
      sessions.sessions.map(session => [
        session.id,
        trimSessionWindow(session),
      ]),
    );
    for (const [id, window] of entry.recent)
      if (entry.sessions.get(id)?.revision !== window.revision)
        entry.recent.delete(id);
    entry.reviews = new Map(reviews.reviews.map(review => [review.id, review]));
    entry.scheduledJobRevisions = new Map();
    entry.workflowRunRevisions = new Map();
    entry.workflowStepRevisions = new Map();
    for (const event of entry.buffered?.drain() ?? [])
      this.apply(entry, event, false);
    entry.buffered = undefined;
    entry.computer.instanceId = health.instanceId;
    entry.computer.capabilities = health.capabilities ?? [];
    entry.computer.lastSyncedAt = new Date().toISOString();
    entry.computer.error = null;
    this.publish({
      type: 'host-snapshot',
      hostId: entry.computer.id,
      sessions: this.listSessions(entry.computer.id),
      reviews: this.listReviews(entry.computer.id),
    });
    entry.computer.status = 'connected';
    entry.connectedAt = Date.now();
    clearTimeout(entry.recoveryTimer);
    entry.recoveryTimer = undefined;
    log.info(
      `${entry.computer.kind === 'local' ? 'Local' : 'Remote computer'} is connected.`,
    );
    this.publishComputers();
    this.scheduleCache();
  }

  private rememberScheduledJob(entry: Entry, scheduledJob: ScheduledJob) {
    const seen = entry.scheduledJobRevisions.get(scheduledJob.id);
    if (seen === undefined || seen < scheduledJob.revision)
      entry.scheduledJobRevisions.set(scheduledJob.id, scheduledJob.revision);
  }

  private advance(
    revisions: Map<string, number>,
    record: { id: string; revision: number },
  ) {
    const seen = revisions.get(record.id);
    if (seen !== undefined && seen >= record.revision) return false;
    revisions.set(record.id, record.revision);
    return true;
  }

  private apply(entry: Entry, event: DesktopEvent, publish = true) {
    const hostId = entry.computer.id;
    if (event.type === 'scheduled-job-changed') {
      const seen = entry.scheduledJobRevisions.get(event.scheduledJob.id);
      if (seen !== undefined && seen >= event.scheduledJob.revision) return;
      this.rememberScheduledJob(entry, event.scheduledJob);
      if (publish)
        this.publish({
          type: 'scheduled-job-changed',
          scheduledJob: { ...event.scheduledJob, hostId },
        });
      return;
    }
    if (event.type === 'scheduled-job-removed') {
      entry.scheduledJobRevisions.delete(event.scheduledJobId);
      if (publish)
        this.publish({
          type: 'scheduled-job-removed',
          hostId,
          scheduledJobId: event.scheduledJobId,
          revision: event.revision,
        });
      return;
    }
    if (event.type === 'scheduled-job-run-changed') {
      if (publish)
        this.publish({
          type: 'scheduled-job-run-changed',
          run: { ...event.run, hostId },
        });
      return;
    }
    if (event.type === 'workflow-run-changed') {
      if (!this.advance(entry.workflowRunRevisions, event.run)) return;
      if (publish)
        this.publish({
          type: 'workflow-run-changed',
          run: { ...event.run, hostId },
        });
      return;
    }
    if (event.type === 'workflow-step-changed') {
      if (!this.advance(entry.workflowStepRevisions, event.step)) return;
      if (publish)
        this.publish({
          type: 'workflow-step-changed',
          step: { ...event.step, hostId },
        });
      return;
    }
    if (event.type === 'session-groups-changed') {
      if (publish) this.publish({ ...event, hostId });
      return;
    }
    if (event.type === 'pull-request-review-changed') {
      if (publish)
        this.publish({
          type: 'pull-request-review-changed',
          draft: { ...event.draft, hostId },
        });
      return;
    }
    if (event.type === 'sessions-removed') {
      const removed = new Set(event.sessionIds);
      const known = event.sessionIds.filter(id => entry.sessions.delete(id));
      for (const [id, review] of entry.reviews)
        if (removed.has(review.sessionId)) entry.reviews.delete(id);
      if (publish && known.length)
        this.publish({ type: 'sessions-removed', hostId, sessionIds: known });
      entry.computer.lastSyncedAt = new Date().toISOString();
      this.scheduleCache();
      return;
    }
    if (
      event.type === 'workflow-assistant-proposal' ||
      event.type === 'workflow-assistant-change' ||
      event.type === 'workflow-assistant-change-refused'
    ) {
      if (publish) this.publish({ ...event, hostId });
      return;
    }
    if (
      event.type === 'session-changed' ||
      event.type === 'session-message-upserted'
    ) {
      if (!this.applySession(entry, sessionChange(event))) return;
      if (publish)
        this.publish(
          event.type === 'session-changed'
            ? {
                type: 'session-changed',
                session: { ...event.session, hostId },
              }
            : { ...event, session: { ...event.session, hostId } },
        );
    } else if (event.type === 'review-changed') {
      const old = entry.reviews.get(event.review.id);
      if (old && old.revision >= event.review.revision) return;
      entry.reviews.set(event.review.id, event.review);
      if (publish)
        this.publish({
          type: 'review-changed',
          review: { ...event.review, hostId },
        });
    }
    entry.computer.lastSyncedAt = new Date().toISOString();
    this.scheduleCache();
  }

  private applySession(entry: Entry, change: SessionChange) {
    const id = change.session.id;
    const summary = applySessionChange(entry.sessions.get(id), change);
    if (!summary) return false;
    entry.sessions.set(id, trimSessionWindow(summary.session));
    const recent = entry.recent.get(id);
    if (recent) {
      const applied = applySessionChange(recent, change);
      if (applied?.gap) entry.recent.delete(id);
      else if (applied) entry.recent.set(id, applied.session);
    }
    return true;
  }

  private remember(entry: Entry, window: SessionWindow) {
    const known = entry.recent.get(window.id);
    entry.recent.delete(window.id);
    entry.recent.set(
      window.id,
      known && known.revision > window.revision ? known : window,
    );
    for (const id of entry.recent.keys()) {
      if (entry.recent.size <= RECENT_SESSION_WINDOWS) break;
      entry.recent.delete(id);
    }
  }

  async getSession(
    input: GetSessionInput,
    hostId = 'local',
    { remember = true }: { remember?: boolean } = {},
  ): Promise<DesktopSession> {
    const entry = this.get(hostId);
    if (entry.computer.status !== 'connected') {
      const offline =
        entry.recent.get(input.sessionId) ??
        entry.sessions.get(input.sessionId);
      if (!offline)
        throw new Error(
          'This conversation is not saved on this device. Connect to load it.',
        );
      return { ...offline, hostId };
    }
    const { response } = await this.dispatch('get-session', input, hostId);
    if (response.type !== 'session')
      throw new Error('Unexpected host response.');
    this.apply(entry, { type: 'session-changed', session: response.session });
    if (remember) {
      this.remember(entry, response.session);
      this.scheduleCache();
    }
    return { ...response.session, hostId };
  }

  async readSessionMessages(
    input: ReadSessionMessagesInput,
    hostId = 'local',
  ): Promise<SessionMessagePage> {
    const entry = this.get(hostId);
    if (entry.computer.status !== 'connected')
      return this.offlinePage(entry, input);
    const { response } = await this.dispatch(
      'read-session-messages',
      input,
      hostId,
    );
    if (response.type !== 'session-messages')
      throw new Error('Unexpected host response.');
    const recent = entry.recent.get(input.sessionId);
    const extended = recent && prependSessionMessages(recent, response.page);
    if (extended) {
      entry.recent.set(input.sessionId, extended);
      this.scheduleCache();
    }
    return response.page;
  }

  private offlinePage(
    entry: Entry,
    input: ReadSessionMessagesInput,
  ): SessionMessagePage {
    const window = entry.recent.get(input.sessionId);
    const end =
      window?.messages.findIndex(message => message.id === input.cursor) ?? -1;
    if (!window || end < 1)
      throw new Error(
        'Earlier messages are not saved on this device. Connect to load them.',
      );
    const start = Math.max(0, end - (input.limit ?? sessionHistoryLimits.page));
    const offset = windowOffset(window);
    return {
      sessionId: window.id,
      revision: window.revision,
      messageCount: window.messageCount,
      startIndex: offset + start,
      messages: window.messages.slice(start, end),
      nextCursor:
        offset + start > 0 ? (window.messages[start]?.id ?? null) : null,
    };
  }

  private persistConfiguration() {
    if (this.configurationError) throw new Error(this.configurationError);
    return this.store.write(
      'computers.json',
      {
        version: 1,
        computers: [...this.entries.values()]
          .filter(entry => entry.computer.ssh)
          .map(entry => ({
            id: entry.computer.id,
            input: entry.computer.ssh,
            instanceId: entry.computer.instanceId,
          })),
      },
      512 * 1024,
    );
  }

  private scheduleCache() {
    if (this.closing || this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = undefined;
      void this.saveOfflineCache();
    }, 1000);
  }

  private async saveOfflineCache() {
    try {
      await this.persistCache();
    } catch (error) {
      for (const entry of this.entries.values())
        if (entry.computer.kind === 'ssh')
          entry.computer.error =
            `Offline history could not be saved. ${this.describe(error)}`.slice(
              0,
              2000,
            );
      this.publishComputers();
    }
  }

  private persistCache() {
    if (this.workLaptopMode) return Promise.resolve();
    const computers: CachedComputer[] = [];
    const value = { version: 2, computers };
    for (const entry of this.entries.values()) {
      if (
        entry.computer.kind !== 'ssh' ||
        !entry.computer.instanceId ||
        !entry.computer.lastSyncedAt
      )
        continue;
      computers.push({
        id: entry.computer.id,
        instanceId: entry.computer.instanceId,
        lastSyncedAt: entry.computer.lastSyncedAt,
        sessions: [...entry.sessions.values()],
        recent: [...entry.recent.values()],
        reviews: [...entry.reviews.values()],
      });
    }
    while (
      Buffer.byteLength(JSON.stringify(value)) > OFFLINE_CACHE_BYTES &&
      computers.some(computer => computer.recent.length > 0)
    )
      for (const computer of computers) computer.recent.shift();
    return this.store.write('computer-cache.json', value, OFFLINE_CACHE_BYTES);
  }
}
