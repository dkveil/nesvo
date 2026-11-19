import { useState } from 'react';
import type { RuleEntryMetrics } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { formatDate } from '@/shared/lib/format-date';
import { Badge } from '@/shared/ui/badge';

type Props = {
  metrics?: RuleEntryMetrics | null;
  kind: 'instruction' | 'check';
  since: string;
  now?: number;
  stacked?: boolean;
};

const UNUSED_MS = 60 * 86_400_000;

export function RuleUsage({
  metrics,
  kind,
  since,
  now,
  stacked = false,
}: Props) {
  const [mountedAt] = useState(() => Date.now());
  const unusedAt = Date.parse(metrics?.lastDelivered ?? since);
  const unused =
    Number.isFinite(unusedAt) && (now ?? mountedAt) - unusedAt >= UNUSED_MS;
  const repeatedlyCited = kind === 'instruction' && (metrics?.cited ?? 0) >= 2;
  return (
    <div className="mt-2 space-y-1.5">
      <div
        className={cn(
          'flex flex-wrap items-center gap-y-1 text-xs text-muted-foreground tabular-nums',
          stacked ? 'gap-x-2' : 'gap-x-3',
        )}
      >
        <span>Delivered {metrics?.delivered ?? 0}</span>
        <span>Cited {metrics?.cited ?? 0}</span>
        <span className={stacked ? 'basis-full' : undefined}>
          Last cited{' '}
          {metrics?.lastCited ? (
            <time dateTime={metrics.lastCited}>
              {formatDate(metrics.lastCited)}
            </time>
          ) : (
            '—'
          )}
        </span>
      </div>
      {(repeatedlyCited || unused) && (
        <div className="flex flex-wrap gap-1.5">
          {repeatedlyCited && (
            <Badge tone="warning" size="xs">
              Keeps failing, consider a check
            </Badge>
          )}
          {unused && <Badge size="xs">Unused</Badge>}
        </div>
      )}
    </div>
  );
}
