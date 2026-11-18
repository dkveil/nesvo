import { useState } from 'react';
import type { RuleEntryMetrics } from '@nesvo/contracts';
import { Badge } from '@/shared/ui/badge';

type Props = {
  metrics?: RuleEntryMetrics | null;
  kind: 'instruction' | 'check';
  since: string;
  now?: number;
};

const UNUSED_MS = 60 * 86_400_000;
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function RuleUsage({ metrics, kind, since, now }: Props) {
  const [mountedAt] = useState(() => Date.now());
  const unusedAt = Date.parse(metrics?.lastDelivered ?? since);
  const unused =
    Number.isFinite(unusedAt) && (now ?? mountedAt) - unusedAt >= UNUSED_MS;
  const repeatedlyCited = kind === 'instruction' && (metrics?.cited ?? 0) >= 2;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground tabular-nums">
      <span>Delivered {metrics?.delivered ?? 0}</span>
      <span>Cited {metrics?.cited ?? 0}</span>
      <span>
        Last cited{' '}
        {metrics?.lastCited ? date.format(new Date(metrics.lastCited)) : '—'}
      </span>
      {repeatedlyCited && (
        <Badge tone="warning" size="xs">
          Keeps failing, consider a check
        </Badge>
      )}
      {unused && <Badge size="xs">Unused</Badge>}
    </span>
  );
}
