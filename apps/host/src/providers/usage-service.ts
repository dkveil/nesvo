import {
  providerUsageSchema,
  type ProviderUsage,
  type ProviderUsageInput,
} from '@nesvo/contracts';
import { inspectClaudeUsage } from './claude';
import { inspectCodexUsage } from './codex';

export class ProviderUsageService {
  cachedWindows() {
    const now = Date.now();
    const ready = [...this.cached.values()].filter(
      entry => entry.expiresAt > now && entry.value.status === 'ready',
    );
    return {
      available: ready.length > 0,
      count: ready.reduce(
        (count, entry) => count + entry.value.windows.length,
        0,
      ),
    };
  }
  private readonly controller = new AbortController();
  private readonly cached = new Map<
    string,
    { value: ProviderUsage; expiresAt: number; failures: number }
  >();
  private readonly pending = new Map<string, Promise<ProviderUsage>>();

  async close(): Promise<void> {
    this.controller.abort();
    this.cached.clear();
    await Promise.allSettled(this.pending.values());
  }

  read(
    { provider, profileId }: ProviderUsageInput,
    environment?: Readonly<Record<string, string>>,
    refresh = false,
  ): Promise<ProviderUsage> {
    const key = `${provider}:${profileId ?? ''}`;
    const { signal } = this.controller;
    if (signal.aborted) return Promise.reject(new Error('Host is closing.'));
    const active = this.pending.get(key);
    if (active) return active;
    const previous = this.cached.get(key);
    if (!refresh && previous && Date.now() < previous.expiresAt)
      return Promise.resolve(previous.value);
    const operation = (
      provider === 'Codex'
        ? inspectCodexUsage(signal, environment)
        : inspectClaudeUsage(signal, environment)
    )
      .then(value => providerUsageSchema.parse(value))
      .catch((): ProviderUsage => ({
        provider,
        status: 'error',
        account: null,
        windows: [],
        checkedAt: new Date().toISOString(),
        source: null,
        ordinaryUsageAllowed: null,
        detail: 'Account limits could not be read. Refresh to try again.',
      }))
      .then(value => {
        signal.throwIfAborted();
        const failures =
          value.status === 'ready'
            ? 0
            : Math.min((previous?.failures ?? 0) + 1, 5);
        const delay = failures
          ? Math.min(300_000 * 2 ** (failures - 1), 3_600_000)
          : provider === 'Claude Code'
            ? 240_000
            : 30_000;
        const expiresAt = Date.now() + delay;
        const observation = failures
          ? {
              ...value,
              detail: `${(value.detail ?? 'Account limits are unavailable.').slice(0, 800)} Next provider check after ${new Date(expiresAt).toISOString()}.`,
            }
          : value;
        this.cached.set(key, { value: observation, expiresAt, failures });
        return observation;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }
}
