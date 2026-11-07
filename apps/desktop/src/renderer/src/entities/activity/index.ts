import type { SessionActivity, Session } from '@nesvo/contracts';

export type { SessionActivity } from '@nesvo/contracts';

export type ActivityBatch = {
  id: string;
  kind: SessionActivity['kind'];
  items: SessionActivity[];
};

export const activityStatusLabels: Record<SessionActivity['status'], string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  declined: 'Declined',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

export function elapsedLabel(
  startedAt: string,
  completedAt: string | null,
  now: number,
) {
  const duration = Math.max(
    0,
    (completedAt ? Date.parse(completedAt) : now) - Date.parse(startedAt),
  );
  const seconds = Math.floor(duration / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function runLabel(
  status: Session['status'],
  elapsed: string,
  live: boolean,
) {
  if (live)
    return status === 'stopping'
      ? elapsed
        ? `Stopping after ${elapsed}`
        : 'Stopping'
      : elapsed
        ? `Working for ${elapsed}`
        : 'Working';
  if (status === 'stopped')
    return elapsed ? `Stopped after ${elapsed}` : 'Stopped';
  if (status === 'failed')
    return elapsed ? `Failed after ${elapsed}` : 'Failed';
  if (status === 'interrupted')
    return elapsed ? `Interrupted after ${elapsed}` : 'Interrupted';
  return elapsed ? `Worked for ${elapsed}` : 'Completed';
}

export function activityBatches(items: SessionActivity[]) {
  const batches: ActivityBatch[] = [];
  for (const item of items) {
    const previous = batches.at(-1);
    if (
      item.status === 'completed' &&
      previous?.kind === item.kind &&
      previous.items.every(entry => entry.status === 'completed')
    )
      previous.items.push(item);
    else batches.push({ id: item.id, kind: item.kind, items: [item] });
  }
  return batches;
}

export function batchLabel(batch: ActivityBatch) {
  const count = batch.items.length;
  const paths = new Set(
    batch.items.flatMap(item => item.paths).filter(Boolean),
  );
  if (batch.kind === 'command') return `${count} commands`;
  if (batch.kind === 'search') return `${count} searches`;
  if (batch.kind === 'read')
    return paths.size > 0
      ? `Read ${paths.size} ${paths.size === 1 ? 'file' : 'files'}`
      : `${count} reads`;
  if (batch.kind === 'file-change')
    return paths.size > 0
      ? `Changed ${paths.size} ${paths.size === 1 ? 'file' : 'files'}`
      : `${count} file changes`;
  return `${count} tool calls`;
}

export function activitySummary(items: SessionActivity[]) {
  const categories: SessionActivity['kind'][] = [
    'command',
    'file-change',
    'read',
    'search',
    'tool',
  ];
  const selected = categories
    .map(kind => ({ kind, items: items.filter(item => item.kind === kind) }))
    .filter(group => group.items.length > 0);
  const labels = selected.slice(0, 2).map(group => {
    const count = group.items.length;
    if (group.kind === 'command')
      return `${count} ${count === 1 ? 'command' : 'commands'}`;
    if (group.kind === 'search')
      return `${count} ${count === 1 ? 'search' : 'searches'}`;
    if (group.kind === 'read')
      return `${count} ${count === 1 ? 'read' : 'reads'}`;
    if (group.kind === 'file-change') {
      const paths = new Set(
        group.items.flatMap(item => item.paths).filter(Boolean),
      );
      return paths.size
        ? `${paths.size} ${paths.size === 1 ? 'file change' : 'file changes'}`
        : `${count} file changes`;
    }
    return `${count} ${count === 1 ? 'tool call' : 'tool calls'}`;
  });
  const remaining = selected
    .slice(2)
    .reduce((sum, group) => sum + group.items.length, 0);
  if (remaining) labels.push(`+${remaining} more`);
  return labels.join(' · ');
}
