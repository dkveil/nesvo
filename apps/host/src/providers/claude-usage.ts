import { type ProviderUsage } from '@nesvo/contracts';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function label(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, limit) || null
  );
}

export function claudeUsageResult(
  value: unknown,
  accountValue: unknown,
): ProviderUsage {
  const usage = object(value);
  const account = object(accountValue);
  const accountLabel =
    label(account?.email, 320) ?? label(account?.organization, 320);
  const plan =
    label(usage?.subscription_type, 100) ??
    label(account?.subscriptionType, 100);
  const result: ProviderUsage = {
    provider: 'Claude Code',
    status: 'unavailable',
    account: accountLabel || plan ? { label: accountLabel, plan } : null,
    windows: [],
    checkedAt: new Date().toISOString(),
    source: 'claude-control',
    ordinaryUsageAllowed: null,
    detail:
      'Claude Code did not report subscription limits for this sign-in. API keys, external providers and credentials without profile access may not expose them.',
  };
  const limits = object(usage?.rate_limits);
  if (usage?.rate_limits_available !== true || !limits) return result;
  let partial = false;
  const add = (
    id: string,
    name: string,
    windowMinutes: number | null,
    value: unknown,
  ) => {
    if (value === undefined || value === null) return;
    const window = object(value);
    const percent = window?.utilization;
    if (
      typeof percent !== 'number' ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 10000 ||
      result.windows.length >= 32
    ) {
      partial = true;
      return;
    }
    const reset =
      typeof window?.resets_at === 'string'
        ? Date.parse(window.resets_at)
        : Number.NaN;
    if (!Number.isFinite(reset)) partial = true;
    result.windows.push({
      id,
      label: name,
      usedPercent: percent,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      windowMinutes,
    });
  };
  add('five_hour', '5-hour', 300, limits.five_hour);
  add('seven_day', 'Weekly', 10080, limits.seven_day);
  add('seven_day_opus', 'Weekly Opus', 10080, limits.seven_day_opus);
  add('seven_day_sonnet', 'Weekly Sonnet', 10080, limits.seven_day_sonnet);
  add(
    'seven_day_oauth_apps',
    'Weekly OAuth apps',
    10080,
    limits.seven_day_oauth_apps,
  );
  if (Array.isArray(limits.model_scoped)) {
    if (limits.model_scoped.length > 32) partial = true;
    for (const [index, window] of limits.model_scoped.slice(0, 32).entries()) {
      const name = label(object(window)?.display_name, 200);
      if (name) add(`model_scoped:${index}`, name, 10080, window);
      else partial = true;
    }
  } else if (limits.model_scoped !== undefined && limits.model_scoped !== null)
    partial = true;
  if (result.windows.length) {
    result.status = 'ready';
    result.detail = partial
      ? 'Some Claude Code limit windows or reset times were unavailable, invalid or omitted by the display limit.'
      : null;
  }
  return result;
}
