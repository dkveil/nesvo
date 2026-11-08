import {
  providerUsageSchema,
  type ProviderUsage,
  type ProviderUsageInput,
} from '@nesvo/contracts';
import { inspectClaudeUsage } from './claude';
import { inspectCodexUsage } from './codex';

export class ProviderUsageService {
  private readonly cached = new Map<
    ProviderUsageInput['provider'],
    { value: ProviderUsage; expiresAt: number; failures: number }
  >();
  private readonly pending = new Map<
    ProviderUsageInput['provider'],
    Promise<ProviderUsage>
  >();

  constructor(private readonly signal: AbortSignal) {}

  read({ provider }: ProviderUsageInput): Promise<ProviderUsage> {
    if (this.signal.aborted)
      return Promise.reject(new Error('Host is closing.'));
    const active = this.pending.get(provider);
    if (active) return active;
    const previous = this.cached.get(provider);
    if (previous && Date.now() < previous.expiresAt)
      return Promise.resolve(previous.value);
    const operation = (
      provider === 'Codex'
        ? inspectCodexUsage(this.signal)
        : inspectClaudeUsage(this.signal)
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
        this.cached.set(provider, { value: observation, expiresAt, failures });
        return observation;
      })
      .finally(() => this.pending.delete(provider));
    this.pending.set(provider, operation);
    return operation;
  }
}
