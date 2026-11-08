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
    { value: ProviderUsage; expiresAt: number }
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
        this.cached.set(provider, { value, expiresAt: Date.now() + 30_000 });
        return value;
      })
      .finally(() => this.pending.delete(provider));
    this.pending.set(provider, operation);
    return operation;
  }
}
