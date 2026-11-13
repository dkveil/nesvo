import { type ProviderUsage, type ScheduledJob } from '@nesvo/contracts';
import { type ProviderUsageService } from '../providers/usage-service';

export const USAGE_PROVIDERS = {
  claude: 'Claude Code',
  codex: 'Codex',
} as const satisfies Record<ScheduledJob['provider'], ProviderUsage['provider']>;

const EXHAUSTED_PERCENT = 100;

type UsageReader = Pick<ProviderUsageService, 'read'>;

export const exhaustedUntil = (
  usage: ProviderUsage,
  now: Date,
): string | null => {
  if (usage.status !== 'ready') return null;
  let latest: number | null = null;
  for (const window of usage.windows) {
    if (window.usedPercent < EXHAUSTED_PERCENT || !window.resetsAt) continue;
    const resetsAt = Date.parse(window.resetsAt);
    if (resetsAt > now.getTime() && (latest === null || resetsAt > latest))
      latest = resetsAt;
  }
  return latest === null ? null : new Date(latest).toISOString();
};

export class ProviderLimitGate {
  private readonly known = new Map<ScheduledJob['provider'], number>();

  constructor(
    private readonly usage: UsageReader,
    private readonly now: () => Date,
  ) {}

  async limitedUntil(
    provider: ScheduledJob['provider'],
  ): Promise<string | null> {
    const remembered = this.known.get(provider);
    if (remembered !== undefined) {
      if (remembered > this.now().getTime())
        return new Date(remembered).toISOString();
      this.known.delete(provider);
    }
    const resetAt = exhaustedUntil(
      await this.usage.read({ provider: USAGE_PROVIDERS[provider] }),
      this.now(),
    );
    if (resetAt) this.remember(provider, resetAt);
    return resetAt;
  }

  remember(provider: ScheduledJob['provider'], resetAt: string): void {
    const at = Date.parse(resetAt);
    if (at > this.now().getTime()) this.known.set(provider, at);
  }
}
