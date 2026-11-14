import { randomUUID } from 'node:crypto';
import {
  type Computer,
  type DesktopEvent,
  type DesktopScheduledJob,
  type DesktopScheduledJobRun,
  type DesktopScheduledJobRunPage,
  type DesktopPipelineRun,
  type DesktopPipelineRunPage,
  type DesktopSession,
  type DesktopReview,
  type HostCapability,
  type HostHealth,
  type HostRequest,
  type HostResponse,
  type Session,
  type Review,
  type ScheduledJob,
  type PipelineMethod,
  type SshComputerInput,
  type WorkspaceEvent,
  isPipelineMethod,
  sshComputerInputSchema,
} from '@nesvo/contracts';
import { type startHost } from './host-client';
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
type ExecutableMethod = Exclude<
  HostRequest['method'],
  | 'shutdown'
  | 'list-sessions'
  | 'list-reviews'
  | ScheduledJobMethod
  | PipelineMethod
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
  sessions: Map<string, Session>;
  reviews: Map<string, Review>;
  scheduledJobRevisions: Map<string, number>;
  pipelineRunRevisions: Map<string, number>;
  pipelineStepRevisions: Map<string, number>;
  generation: number;
  connection?: Connection;
  unsubscribe?: () => void;
  connecting?: Promise<Computer>;
  buffered?: DesktopEvent[];
  removing?: boolean;
};

const capabilityUpdates: Record<HostCapability, string> = {
  'scheduled-jobs':
    'This computer runs an older Nesvo host without scheduled jobs. Update it, then reconnect.',
  'reasoning-effort':
    'This computer runs an older Nesvo host without reasoning effort support. Update the host or start without an effort.',
  pipelines:
    'Pipelines are not available on this computer yet. Update its Nesvo host, then reconnect.',
};

function requiredCapability(
  method: HostRequest['method'],
  input: unknown,
): HostCapability | null {
  if (
    method === 'list-pipeline-definitions' ||
    method === 'validate-pipeline-definitions'
  )
    return null;
  if (isPipelineMethod(method)) return 'pipelines';
  if (
    method === 'create-session' &&
    typeof input === 'object' &&
    input !== null &&
    'isolation' in input &&
    input.isolation
  )
    return 'pipelines';
  if (
    method === 'create-session' &&
    typeof input === 'object' &&
    input !== null &&
    'effort' in input &&
    input.effort
  )
    return 'reasoning-effort';
  return null;
}

export class ComputerManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private readonly store: ComputerStore;
  private configurationError = '';
  private cacheTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;

  constructor(
    directory: string,
    private readonly local: ReturnType<typeof startHost>,
  ) {
    this.store = new ComputerStore(directory);
    this.entries.set('local', {
      computer: {
        id: 'local',
        name: 'Local',
        kind: 'local',
        status: 'connecting',
        instanceId: null,
        lastSyncedAt: null,
        error: null,
        capabilities: [],
      },
      sessions: new Map(),
      reviews: new Map(),
      scheduledJobRevisions: new Map(),
      pipelineRunRevisions: new Map(),
      pipelineStepRevisions: new Map(),
      generation: 0,
    });
  }

  async initialize() {
    try {
      const raw = await this.store.read('computers.json', 512 * 1024);
      const saved =
        raw === undefined
          ? []
          : computerConfigurationSchema.parse(raw).computers;
      for (const computer of saved)
        this.entries.set(computer.id, {
          computer: {
            id: computer.id,
            name: computer.input.name,
            kind: 'ssh',
            ssh: computer.input,
            instanceId: computer.instanceId,
            status: 'disconnected',
            lastSyncedAt: null,
            error: null,
            capabilities: [],
          },
          sessions: new Map(),
          reviews: new Map(),
          scheduledJobRevisions: new Map(),
          pipelineRunRevisions: new Map(),
          pipelineStepRevisions: new Map(),
          generation: 0,
        });
    } catch {
      this.configurationError =
        'Saved computers could not be read. Restore computers.json before changing the list.';
    }
    try {
      const raw = await this.store.read(
        'computer-cache.json',
        64 * 1024 * 1024,
      );
      for (const cache of raw === undefined
        ? []
        : computerCacheSchema.parse(raw).computers) {
        const entry = this.entries.get(cache.id);
        if (!entry || entry.computer.instanceId !== cache.instanceId) continue;
        entry.sessions = new Map(
          cache.sessions.map(session => [session.id, session]),
        );
        entry.reviews = new Map(
          cache.reviews.map(review => [review.id, review]),
        );
        entry.computer.lastSyncedAt = cache.lastSyncedAt;
      }
    } catch {
      for (const entry of this.entries.values())
        if (entry.computer.kind === 'ssh')
          entry.computer.error =
            'Offline history could not be read. Connect to load it from this computer.';
    }
    const entry = this.get('local');
    entry.connection = {
      request: this.local.request,
      subscribe: this.local.subscribe,
      close: this.local.stop,
    };
    const generation = ++entry.generation;
    this.listen(entry, generation);
    try {
      const health = await this.local.health();
      await this.synchronize(entry, generation, health);
      if (this.configurationError)
        entry.computer.error = this.configurationError;
    } catch (error) {
      entry.computer.status = 'error';
      entry.computer.error = this.describe(error);
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
    if (this.closing) throw new Error('Nesvo is closing.');
    if (this.entries.size >= 9)
      throw new Error('This prototype supports up to eight remote computers.');
    const target = sshComputerInputSchema.parse(input);
    const id = randomUUID();
    const entry: Entry = {
      computer: {
        id,
        name: target.name,
        kind: 'ssh',
        ssh: target,
        status: 'disconnected',
        instanceId: null,
        lastSyncedAt: null,
        error: null,
        capabilities: [],
      },
      sessions: new Map(),
      reviews: new Map(),
      scheduledJobRevisions: new Map(),
      pipelineRunRevisions: new Map(),
      pipelineStepRevisions: new Map(),
      generation: 0,
    };
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

  connectComputer(hostId: string): Promise<Computer> {
    const entry = this.get(hostId);
    if (entry.removing)
      return Promise.reject(new Error('This computer is being removed.'));
    if (this.closing) return Promise.reject(new Error('Nesvo is closing.'));
    if (entry.computer.status === 'connected')
      return Promise.resolve({ ...entry.computer });
    if (entry.connecting) return entry.connecting;
    if (!entry.computer.ssh)
      return Promise.reject(
        new Error('Reopen Nesvo to reconnect its local host.'),
      );
    const generation = ++entry.generation;
    const operation = this.openRemote(entry, generation);
    entry.connecting = operation;
    void operation
      .finally(() => {
        if (entry.connecting === operation) entry.connecting = undefined;
      })
      .catch(() => undefined);
    return operation;
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
      entry.computer.status = 'error';
      entry.computer.error = this.describe(error);
      this.publishComputers();
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
        entry.computer.status = 'error';
        entry.computer.error = this.describe(error);
        entry.buffered = undefined;
        this.detach(entry);
        entry.connection = undefined;
        this.publishComputers();
      }
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async disconnectComputer(hostId: string) {
    const entry = this.get(hostId);
    if (hostId === 'local')
      throw new Error('The local host is managed by Nesvo.');
    ++entry.generation;
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
    method: ExecutableMethod | ScheduledJobMethod | PipelineMethod,
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
    const { entry, response } = await this.dispatch(
      method,
      input,
      hostId,
      'scheduled-jobs',
    );
    const expected = {
      'list-scheduled-jobs': 'scheduled-jobs',
      'save-scheduled-job': 'scheduled-job',
      'set-scheduled-job-active': 'scheduled-job',
      'delete-scheduled-job': 'scheduled-job-deleted',
      'list-scheduled-job-runs': 'scheduled-job-runs',
      'run-scheduled-job-now': 'scheduled-job-run',
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

  async executePipeline(
    method: PipelineMethod,
    input: unknown,
    hostId: string,
  ) {
    const { entry, response } = await this.dispatch(method, input, hostId);
    const expected = {
      'list-pipeline-definitions': 'pipeline-definitions',
      'validate-pipeline-definitions': 'pipeline-definitions',
      'save-pipeline-definition': 'pipeline-definitions',
      'delete-pipeline-definition': 'pipeline-definitions',
      'start-pipeline-task': 'pipeline-run',
      'run-pipeline-steps': 'pipeline-run',
      'decide-pipeline-gate': 'pipeline-run',
      'skip-pipeline-step': 'pipeline-run',
      'resume-pipeline-run': 'pipeline-run',
      'stop-pipeline-run': 'pipeline-run',
      'remove-pipeline-worktree': 'pipeline-run',
      'list-pipeline-runs': 'pipeline-runs',
      'get-pipeline-run': 'pipeline-run-detail',
      'read-pipeline-evidence': 'pipeline-evidence',
      'pipeline-metrics': 'pipeline-metrics',
      'pipeline-assistant-send': 'pipeline-assistant-turn',
    }[method];
    const definitionWrite =
      (method === 'save-pipeline-definition' ||
        method === 'delete-pipeline-definition') &&
      (response.type === 'pipeline-definition-conflict' ||
        response.type === 'pipeline-definition-refused');
    if (response.type !== expected && !definitionWrite)
      throw new Error('Unexpected host response.');
    switch (response.type) {
      case 'pipeline-definitions':
        return response.catalog;
      case 'pipeline-definition-conflict':
      case 'pipeline-definition-refused':
        return Object.fromEntries(
          Object.entries(response).filter(([key]) => key !== 'id'),
        );
      case 'pipeline-run':
        this.apply(entry, { type: 'pipeline-run-changed', run: response.run });
        return { ...response.run, hostId } satisfies DesktopPipelineRun;
      case 'pipeline-runs':
        return {
          ...response.page,
          runs: response.page.runs.map(run => ({ ...run, hostId })),
        } satisfies DesktopPipelineRunPage;
      case 'pipeline-run-detail':
        return {
          run: { ...response.detail.run, hostId },
          steps: response.detail.steps.map(step => ({ ...step, hostId })),
        };
      case 'pipeline-evidence':
        return response.evidence;
      case 'pipeline-metrics':
        return response.metrics;
      case 'pipeline-assistant-turn':
        return response.turn;
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
      'create-session': 'session',
      'send-message': 'session',
      'stop-run': 'session',
      'respond-approval': 'session',
      'decide-delegation': 'session',
      'decide-review': 'review',
      'discover-skills': 'skills',
      'list-workspace-directory': 'workspace-directory',
      'search-workspace-files': 'workspace-search',
      'read-workspace-file': 'workspace-file',
    }[method];
    if (response.type !== expected)
      throw new Error('Unexpected host response.');
    switch (response.type) {
      case 'provider-usage':
        return response.usage;
      case 'health':
        return response.health;
      case 'claude-status':
      case 'codex-status':
        return response.status;
      case 'skills':
        return response.catalog;
      case 'workspace-directory':
        return response.directory;
      case 'workspace-search':
        return response.search;
      case 'workspace-file':
        return response.file;
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
    clearTimeout(this.cacheTimer);
    await this.persistCache().catch(() => undefined);
    await Promise.allSettled(
      [...this.entries.values()].map(async entry => {
        ++entry.generation;
        entry.unsubscribe?.();
        await entry.connection?.close();
      }),
    );
  }

  private get(hostId: string) {
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
    entry.buffered = [];
    entry.unsubscribe = entry.connection!.subscribe(event => {
      if (!this.current(entry, generation)) return;
      if (event.type === 'host-disconnected') {
        entry.computer.status = 'error';
        entry.computer.error =
          entry.computer.kind === 'local'
            ? 'The local host stopped. Reopen Nesvo.'
            : 'Connection lost. Work on this computer may still be running. Reconnect to refresh its state.';
        entry.buffered = undefined;
        this.publish({ type: 'host-disconnected', hostId: entry.computer.id });
        this.publishComputers();
        return;
      }
      if (entry.buffered) {
        if (entry.buffered.length >= 256) {
          entry.computer.status = 'error';
          entry.computer.error =
            'Too many changes arrived while synchronizing. Reconnect to refresh.';
          entry.buffered = undefined;
          void entry.connection?.close().catch(() => undefined);
          this.publishComputers();
        } else entry.buffered.push(event);
      } else this.apply(entry, event);
    });
  }

  private async synchronize(
    entry: Entry,
    generation: number,
    health: HostHealth,
  ) {
    if (!this.current(entry, generation) || this.failed(entry))
      throw new Error('Connection lost while synchronizing.');
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
      sessions.sessions.map(session => [session.id, session]),
    );
    entry.reviews = new Map(reviews.reviews.map(review => [review.id, review]));
    entry.scheduledJobRevisions = new Map();
    entry.pipelineRunRevisions = new Map();
    entry.pipelineStepRevisions = new Map();
    for (const event of entry.buffered ?? []) this.apply(entry, event, false);
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
    if (event.type === 'pipeline-run-changed') {
      if (!this.advance(entry.pipelineRunRevisions, event.run)) return;
      if (publish)
        this.publish({
          type: 'pipeline-run-changed',
          run: { ...event.run, hostId },
        });
      return;
    }
    if (event.type === 'pipeline-step-changed') {
      if (!this.advance(entry.pipelineStepRevisions, event.step)) return;
      if (publish)
        this.publish({
          type: 'pipeline-step-changed',
          step: { ...event.step, hostId },
        });
      return;
    }
    if (event.type === 'pipeline-assistant-proposal') {
      if (publish) this.publish({ ...event, hostId });
      return;
    }
    if (event.type === 'session-changed') {
      const old = entry.sessions.get(event.session.id);
      if (old && old.revision >= event.session.revision) return;
      entry.sessions.set(event.session.id, event.session);
      if (publish)
        this.publish({
          type: 'session-changed',
          session: { ...event.session, hostId },
        });
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
    const computers: CachedComputer[] = [];
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
        reviews: [...entry.reviews.values()],
      });
    }
    return this.store.write(
      'computer-cache.json',
      { version: 1, computers },
      64 * 1024 * 1024,
    );
  }
}
