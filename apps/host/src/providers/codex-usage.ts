import { providerUsageSchema, type ProviderUsage } from '@nesvo/contracts';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid usage response.');
  return value as Record<string, unknown>;
}

function windowLabel(minutes: number | null, fallback: string) {
  if (minutes === null) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function readCodexUsage(
  raw: unknown,
  account: ProviderUsage['account'],
): ProviderUsage {
  const response = record(raw);
  const keyed = response.rateLimitsByLimitId;
  const groups =
    keyed && Object.keys(record(keyed)).length
      ? Object.entries(record(keyed))
      : [['codex', response.rateLimits]];
  if (groups.length > 16) throw new Error('Too many usage windows.');
  const windows: ProviderUsage['windows'] = [];
  for (const [key, value] of groups) {
    const group = record(value);
    const label =
      typeof group.limitName === 'string' && group.limitName.trim()
        ? group.limitName
        : key;
    for (const slot of ['primary', 'secondary'] as const) {
      if (group[slot] == null) continue;
      const item = record(group[slot]);
      const minutes = item.windowDurationMins ?? null;
      const reset = item.resetsAt;
      if (
        typeof item.usedPercent !== 'number' ||
        (minutes !== null && typeof minutes !== 'number') ||
        (reset != null &&
          (typeof reset !== 'number' || !Number.isFinite(reset)))
      )
        throw new Error('Invalid usage window.');
      windows.push({
        id: `${key}:${slot}`,
        label: `${label} · ${windowLabel(minutes, slot === 'primary' ? 'Primary window' : 'Secondary window')}`,
        usedPercent: item.usedPercent,
        windowMinutes: minutes,
        resetsAt: reset == null ? null : new Date(reset * 1000).toISOString(),
      });
    }
  }
  return providerUsageSchema.parse({
    provider: 'Codex',
    status: windows.length ? 'ready' : 'unavailable',
    account,
    windows,
    checkedAt: new Date().toISOString(),
    source: 'codex-app-server',
    ordinaryUsageAllowed:
      typeof response.ordinaryUsageAllowed === 'boolean'
        ? response.ordinaryUsageAllowed
        : null,
    detail: windows.length ? null : 'Codex did not report usage windows.',
  });
}
