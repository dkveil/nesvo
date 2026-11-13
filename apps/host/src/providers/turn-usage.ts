import { type TurnUsage } from '@nesvo/contracts';

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sum(values: (number | null)[]): number | null {
  const reported = values.filter(value => value !== null);
  return reported.length ? reported.reduce((a, b) => a + b, 0) : null;
}

function finish(usage: Omit<TurnUsage, 'source'>): TurnUsage {
  const reported = Object.values(usage).some(value => value !== null);
  return { ...usage, source: reported ? 'provider-report' : null };
}

export function unreportedUsage(): TurnUsage {
  return finish({
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    costUsd: null,
    durationMs: null,
  });
}

export function claudeTurnUsage(frame: RecordValue): TurnUsage {
  const usage = object(frame.usage);
  const cacheRead = count(usage?.cache_read_input_tokens);
  const cost = frame.total_cost_usd;
  return finish({
    inputTokens: sum([
      count(usage?.input_tokens),
      cacheRead,
      count(usage?.cache_creation_input_tokens),
    ]),
    outputTokens: count(usage?.output_tokens),
    cachedInputTokens: cacheRead,
    costUsd:
      typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
        ? cost
        : null,
    durationMs: count(frame.duration_ms),
  });
}

export type CodexTokenSnapshot = { last: RecordValue; total: RecordValue };

export function codexTokenSnapshot(
  params: RecordValue,
): CodexTokenSnapshot | null {
  const usage = object(params.tokenUsage);
  const last = object(usage?.last);
  const total = object(usage?.total);
  return last && total ? { last, total } : null;
}

function codexDelta(
  field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens',
  first: CodexTokenSnapshot,
  latest: CodexTokenSnapshot,
): number | null {
  const end = count(latest.total[field]);
  const firstTotal = count(first.total[field]);
  const firstLast = count(first.last[field]);
  if (end === null || firstTotal === null || firstLast === null) return null;
  const start = firstTotal - firstLast;
  return start >= 0 && end >= start ? end - start : null;
}

export function codexTurnUsage(
  first: CodexTokenSnapshot | null,
  latest: CodexTokenSnapshot | null,
  turn: RecordValue | null,
): TurnUsage {
  const tokens = first && latest;
  return finish({
    inputTokens: tokens ? codexDelta('inputTokens', first, latest!) : null,
    outputTokens: tokens ? codexDelta('outputTokens', first, latest!) : null,
    cachedInputTokens: tokens
      ? codexDelta('cachedInputTokens', first, latest!)
      : null,
    costUsd: null,
    durationMs: count(turn?.durationMs),
  });
}
