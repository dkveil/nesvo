import type { SessionContext } from '@nesvo/contracts';

export const COMPACT_SUGGESTION_PERCENT = 80;

const tokenFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function contextPercent(context: SessionContext): number {
  return Math.min(
    100,
    Math.round((context.usedTokens / context.windowTokens) * 100),
  );
}

export function formatTokens(count: number): string {
  return tokenFormat.format(count);
}

export function suggestsCompaction(context: SessionContext | null): boolean {
  return !!context && contextPercent(context) >= COMPACT_SUGGESTION_PERCENT;
}
