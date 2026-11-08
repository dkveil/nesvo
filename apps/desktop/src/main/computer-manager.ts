import { randomUUID } from 'node:crypto';
import {
  type Computer,
  type DesktopEvent,
  type DesktopSession,
  type DesktopReview,
  type HostHealth,
  type HostRequest,
  type HostResponse,
  type Session,
  type Review,
  type SshComputerInput,
  type WorkspaceEvent,
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
  generation: number;
  connection?: Connection;
  unsubscribe?: () => void;
  connecting?: Promise<Computer>;
  buffered?: DesktopEvent[];
  removing?: boolean;
};

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
      },
      sessions: new Map(),
      reviews: new Map(),
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
          },
          sessions: new Map(),
          reviews: new Map(),
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
      },
      sessions: new Map(),
      reviews: new Map(),
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

  async execute(
    method: Exclude<
      HostRequest['method'],
      'shutdown' | 'list-sessions' | 'list-reviews'
    >,
    input: unknown,
    hostId = 'local',
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
    const generation = entry.generation;
    const response = await entry.connection.request(method, input);
    if (
      !this.current(entry, generation) ||
      entry.computer.status !== 'connected'
    )
      throw new Error(
        'The connection changed before the response arrived. Refresh its state before retrying.',
      );
    const expected = {
      health: 'health',
      'claude-status': 'claude-status',
      'codex-status': 'codex-status',
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
    for (const event of entry.buffered ?? []) this.apply(entry, event, false);
    entry.buffered = undefined;
    entry.computer.instanceId = health.instanceId;
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

  private apply(entry: Entry, event: DesktopEvent, publish = true) {
    if (event.type === 'session-changed') {
      const old = entry.sessions.get(event.session.id);
      if (old && old.revision >= event.session.revision) return;
      entry.sessions.set(event.session.id, event.session);
      if (publish)
        this.publish({
          type: 'session-changed',
          session: { ...event.session, hostId: entry.computer.id },
        });
    } else if (event.type === 'review-changed') {
      const old = entry.reviews.get(event.review.id);
      if (old && old.revision >= event.review.revision) return;
      entry.reviews.set(event.review.id, event.review);
      if (publish)
        this.publish({
          type: 'review-changed',
          review: { ...event.review, hostId: entry.computer.id },
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
