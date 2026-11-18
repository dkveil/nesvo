import { useEffect, useEffectEvent, useState } from 'react';
import type {
  MergedWorktreeCleanup,
  MergedWorktreeFinish,
} from '@nesvo/contracts';
import {
  errorDetail,
  sessionProjectLabel,
  type Session,
} from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import { DialogCancel, DialogFooter } from '@/shared/ui/dialog';
import { EmptyState } from '@/shared/ui/empty-state';
import { Label } from '@/shared/ui/label';
import { StatusMessage } from '@/shared/ui/status-message';
import { blockerSummary } from './blocker-summary';

type Props = {
  candidates: Session[];
  computerName: (hostId: string) => string;
  read: (session: Session) => Promise<MergedWorktreeCleanup>;
  finish: (session: Session) => Promise<MergedWorktreeFinish>;
  onDone: (finished: number) => void;
  onCancel: () => void;
};

type Row = {
  session: Session;
  cleanup: MergedWorktreeCleanup | null;
  error: string;
  finished: boolean;
};

const sessionCount = (count: number) =>
  `${count} session${count === 1 ? '' : 's'}`;

const isReady = (row: Row) =>
  !row.finished && !!row.cleanup && row.cleanup.blockers.length === 0;

const isMerged = (row: Row) =>
  !row.cleanup || row.cleanup.pullRequest.state === 'merged';

function useMergedRows(
  candidates: Session[],
  read: Props['read'],
): { rows: Row[]; loading: boolean; update: (row: Row) => void } {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [loading, setLoading] = useState(true);
  const readRow = useEffectEvent(read);
  useEffect(() => {
    let current = true;
    const load = async () => {
      for (const session of candidates) {
        if (!current) return;
        const row: Row = await readRow(session).then(
          cleanup => ({ session, cleanup, error: '', finished: false }),
          failure => ({
            session,
            cleanup: null,
            error: errorDetail(failure),
            finished: false,
          }),
        );
        if (current)
          setRows(previous => ({ ...previous, [entityKey(session)]: row }));
      }
      if (current) setLoading(false);
    };
    void load();
    return () => {
      current = false;
    };
  }, [candidates]);
  return {
    rows: candidates
      .map(session => rows[entityKey(session)])
      .filter((row): row is Row => !!row)
      .filter(isMerged),
    loading,
    update: row =>
      setRows(previous => ({ ...previous, [entityKey(row.session)]: row })),
  };
}

function MergedRow({
  row,
  checked,
  computerName,
  disabled,
  onCheckedChange,
}: {
  row: Row;
  checked: boolean;
  computerName: string;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { session, cleanup, error, finished } = row;
  const details = [
    cleanup ? `#${cleanup.pullRequest.reference.number}` : '',
    sessionProjectLabel(session),
    computerName,
  ].filter(Boolean);
  const blocked = !!cleanup && cleanup.blockers.length > 0;
  return (
    <li>
      <Label
        data-merged-candidate={session.id}
        className="flex min-w-0 cursor-pointer items-start gap-2.5 rounded-control px-2.5 py-1.5 font-normal transition-colors duration-100 hover:bg-accent"
      >
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled || !isReady(row)}
          onCheckedChange={value => onCheckedChange(value === true)}
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block truncate text-ui leading-5 text-foreground">
            {session.title}
          </span>
          <span className="block truncate text-2xs leading-4 text-muted-foreground">
            {details.join(' · ')}
          </span>
          {finished && (
            <StatusMessage tone="success">
              Worktree removed and session archived.
            </StatusMessage>
          )}
          {blocked && (
            <StatusMessage tone="warning">
              {`${blockerSummary(cleanup)}${cleanup.changes.length > 0 ? ` ${cleanup.changes.slice(0, 3).join(', ')}` : ''}`}
            </StatusMessage>
          )}
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </span>
      </Label>
    </li>
  );
}

export function MergedWorktreeBatch({
  candidates,
  computerName,
  read,
  finish,
  onDone,
  onCancel,
}: Props) {
  const [initial] = useState(candidates);
  const { rows, loading, update } = useMergedRows(initial, read);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pending, setPending] = useState(false);
  const selected = rows.filter(
    row => isReady(row) && !deselected.has(entityKey(row.session)),
  );
  const toggle = (row: Row, checked: boolean) =>
    setDeselected(previous => {
      const next = new Set(previous);
      if (checked) next.delete(entityKey(row.session));
      else next.add(entityKey(row.session));
      return next;
    });
  const finishSelected = async () => {
    setPending(true);
    let finished = 0;
    let failed = 0;
    for (const row of selected) {
      try {
        const result = await finish(row.session);
        const done = result.outcome === 'finished';
        if (done) finished++;
        else failed++;
        update({ ...row, cleanup: result.cleanup, error: '', finished: done });
      } catch (failure) {
        failed++;
        update({ ...row, error: errorDetail(failure) });
      }
    }
    setPending(false);
    if (failed === 0) onDone(finished);
  };
  return (
    <>
      {rows.length > 0 ? (
        <div className="space-y-1">
          <div className="flex justify-end px-2.5">
            <span
              className="text-2xs text-muted-foreground tabular-nums"
              data-merged-count=""
            >
              {loading
                ? `Checking ${rows.length} of ${sessionCount(candidates.length)}…`
                : `${selected.length} of ${sessionCount(rows.length)} selected`}
            </span>
          </div>
          <ul
            aria-label="Sessions with merged pull requests"
            className="max-h-72 overflow-y-auto rounded-surface border p-1"
          >
            {rows.map(row => (
              <MergedRow
                key={entityKey(row.session)}
                row={row}
                checked={
                  isReady(row) && !deselected.has(entityKey(row.session))
                }
                computerName={computerName(row.session.hostId)}
                disabled={pending}
                onCheckedChange={checked => toggle(row, checked)}
              />
            ))}
          </ul>
        </div>
      ) : (
        <EmptyState
          size="sm"
          title={
            loading
              ? 'Checking linked pull requests…'
              : 'No worktree sessions with a merged pull request.'
          }
          className="rounded-surface border"
        />
      )}
      <DialogFooter>
        <DialogCancel onClick={onCancel} disabled={pending} />
        <Button
          size="lg"
          disabled={pending || selected.length === 0}
          aria-busy={pending || undefined}
          onClick={() => void finishSelected()}
        >
          {pending
            ? 'Finishing…'
            : selected.length > 0
              ? `Finish ${sessionCount(selected.length)}`
              : 'Finish selected'}
        </Button>
      </DialogFooter>
    </>
  );
}
