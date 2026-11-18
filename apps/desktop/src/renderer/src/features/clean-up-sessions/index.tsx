import { useEffect, useRef, useState } from 'react';
import type {
  Computer,
  MergedWorktreeCleanup,
  MergedWorktreeFinish,
} from '@nesvo/contracts';
import {
  formatAgo,
  sessionProjectLabel,
  type Session,
} from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { EmptyState } from '@/shared/ui/empty-state';
import { Label } from '@/shared/ui/label';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { TabPanel, Tabs } from '@/shared/ui/tabs';
import { MergedWorktreeBatch } from '@/features/merged-worktree-cleanup/merged-worktree-batch';
import { Toast, ToastRegion } from '@/shared/ui/toast';
import {
  cleanupCandidates,
  cleanupPresets,
  DEFAULT_CLEANUP_DAYS,
  type CleanupCandidate,
  type CleanupPreset,
} from './cleanup-candidates';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: Session[];
  computers: Computer[];
  busyKeys: ReadonlySet<string>;
  isEligibleHost: (hostId: string) => boolean;
  setArchived: (session: Session, archived: boolean) => Promise<boolean>;
  merged?: {
    candidates: Session[];
    read: (session: Session) => Promise<MergedWorktreeCleanup>;
    finish: (session: Session) => Promise<MergedWorktreeFinish>;
  };
};

type CleanupTab = 'inactive' | 'merged';

const CLEANUP_TABS_ID = 'session-cleanup';

type ArchivedBatch = {
  sessions: Session[];
  requested: number;
  restoring: boolean;
};

const CLEANUP_CLOCK_MS = 60_000;
const UNDO_VISIBLE_MS = 15_000;

const sessionCount = (count: number) =>
  `${count} session${count === 1 ? '' : 's'}`;

const presetValue = (days: CleanupPreset) => String(days);

function CandidateRow({
  candidate,
  checked,
  computerName,
  now,
  onCheckedChange,
}: {
  candidate: CleanupCandidate;
  checked: boolean;
  computerName: string;
  now: number;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { session, lastActivityAt } = candidate;
  const details = [
    sessionProjectLabel(session),
    computerName,
    `Last activity ${formatAgo(lastActivityAt, now)}`,
  ].filter(Boolean);
  return (
    <li>
      <Label
        data-cleanup-session={session.id}
        className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 font-normal transition-colors duration-100 hover:bg-accent"
      >
        <Checkbox
          checked={checked}
          onCheckedChange={value => onCheckedChange(value === true)}
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block truncate text-ui leading-5 text-foreground">
            {session.title}
          </span>
          <span className="block truncate text-2xs leading-4 text-muted-foreground">
            {details.join(' · ')}
          </span>
        </span>
      </Label>
    </li>
  );
}

export function SessionCleanup({
  open,
  onOpenChange,
  sessions,
  computers,
  busyKeys,
  isEligibleHost,
  setArchived,
  merged,
}: Props) {
  const now = useNow(CLEANUP_CLOCK_MS);
  const [tab, setTab] = useState<CleanupTab>('inactive');
  const [finishedCount, setFinishedCount] = useState<number | null>(null);
  const finishedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(finishedTimer.current), []);
  const [days, setDays] = useState<CleanupPreset>(DEFAULT_CLEANUP_DAYS);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pending, setPending] = useState(false);
  const [batch, setBatch] = useState<ArchivedBatch | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const candidates = open
    ? cleanupCandidates({ sessions, now, days, isEligibleHost, busyKeys })
    : [];
  const selected = candidates.filter(
    candidate => !deselected.has(entityKey(candidate.session)),
  );
  const allSelected =
    candidates.length > 0 && selected.length === candidates.length;
  const computerName = (hostId: string) =>
    computers.length > 1
      ? (computers.find(computer => computer.id === hostId)?.name ?? hostId)
      : '';
  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setDeselected(new Set());
      setDays(DEFAULT_CLEANUP_DAYS);
      setTab('inactive');
    }
    onOpenChange(next);
  };
  const toggle = (session: Session, checked: boolean) =>
    setDeselected(previous => {
      const next = new Set(previous);
      if (checked) next.delete(entityKey(session));
      else next.add(entityKey(session));
      return next;
    });
  const toggleAll = (checked: boolean) =>
    setDeselected(
      checked
        ? new Set()
        : new Set(candidates.map(candidate => entityKey(candidate.session))),
    );
  const dismissBatch = () => {
    clearTimeout(undoTimer.current);
    setBatch(null);
  };
  const archive = async () => {
    const targets = selected.map(candidate => candidate.session);
    if (targets.length === 0) return;
    setPending(true);
    const results = await Promise.all(
      targets.map(session => setArchived(session, true)),
    );
    setPending(false);
    const archived = targets.filter((_, index) => results[index]);
    setDeselected(new Set());
    setDays(DEFAULT_CLEANUP_DAYS);
    onOpenChange(false);
    clearTimeout(undoTimer.current);
    if (archived.length === 0) {
      setBatch(null);
      return;
    }
    setBatch({
      sessions: archived,
      requested: targets.length,
      restoring: false,
    });
    undoTimer.current = setTimeout(() => setBatch(null), UNDO_VISIBLE_MS);
  };
  const undo = async (current: ArchivedBatch) => {
    clearTimeout(undoTimer.current);
    setBatch({ ...current, restoring: true });
    await Promise.all(
      current.sessions.map(session => setArchived(session, false)),
    );
    setBatch(null);
  };
  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="gap-4 sm:max-w-md" data-session-cleanup="">
          <DialogHeader>
            <DialogTitle>Clean up sessions</DialogTitle>
            <DialogDescription>
              {tab === 'merged'
                ? 'Finish worktree sessions whose pull request GitHub reports as merged: remove the worktree, delete its local branch and archive the session. Sessions with uncommitted or unpushed work are shown and left untouched.'
                : 'Archive sessions without activity. Archived sessions keep their history and can be restored. Running, pinned and sessions that need you are not listed.'}
            </DialogDescription>
          </DialogHeader>
          {merged && (
            <Tabs
              label="Clean-up kind"
              idPrefix={CLEANUP_TABS_ID}
              value={tab}
              onChange={setTab}
              options={[
                { value: 'inactive', label: 'Inactive' },
                {
                  value: 'merged',
                  label: 'Merged pull requests',
                  count: merged.candidates.length || undefined,
                },
              ]}
            />
          )}
          {tab === 'merged' && merged ? (
            <TabPanel
              idPrefix={CLEANUP_TABS_ID}
              value="merged"
              className="space-y-4"
            >
              <MergedWorktreeBatch
                candidates={merged.candidates}
                computerName={computerName}
                read={merged.read}
                finish={merged.finish}
                onCancel={() => close(false)}
                onDone={count => {
                  close(false);
                  clearTimeout(finishedTimer.current);
                  setFinishedCount(count);
                  finishedTimer.current = setTimeout(
                    () => setFinishedCount(null),
                    UNDO_VISIBLE_MS,
                  );
                }}
              />
            </TabPanel>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Inactive for at least
                </span>
                <SegmentedControl
                  label="Inactive for at least"
                  value={presetValue(days)}
                  onChange={value => {
                    setDays(
                      cleanupPresets.find(
                        preset => presetValue(preset) === value,
                      ) ?? DEFAULT_CLEANUP_DAYS,
                    );
                    setDeselected(new Set());
                  }}
                  options={cleanupPresets.map(preset => ({
                    value: presetValue(preset),
                    label: `${preset} days`,
                  }))}
                />
              </div>
              {candidates.length > 0 ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3 px-2.5">
                    <Label className="text-xs font-normal">
                      <Checkbox
                        aria-label="Select all sessions"
                        checked={
                          allSelected
                            ? true
                            : selected.length > 0
                              ? 'indeterminate'
                              : false
                        }
                        onCheckedChange={value => toggleAll(value === true)}
                      />
                      Select all
                    </Label>
                    <span
                      className="text-2xs text-muted-foreground tabular-nums"
                      data-cleanup-count=""
                    >
                      {selected.length} of {sessionCount(candidates.length)}{' '}
                      selected
                    </span>
                  </div>
                  <ul
                    aria-label="Inactive sessions"
                    className="max-h-72 overflow-y-auto rounded-surface border p-1"
                  >
                    {candidates.map(candidate => (
                      <CandidateRow
                        key={entityKey(candidate.session)}
                        candidate={candidate}
                        checked={!deselected.has(entityKey(candidate.session))}
                        computerName={computerName(candidate.session.hostId)}
                        now={now}
                        onCheckedChange={checked =>
                          toggle(candidate.session, checked)
                        }
                      />
                    ))}
                  </ul>
                </div>
              ) : (
                <EmptyState
                  size="sm"
                  title={`No sessions inactive for ${days} days or more.`}
                  className="rounded-surface border"
                />
              )}
              <DialogFooter>
                <DialogCancel onClick={() => close(false)} disabled={pending} />
                <Button
                  size="lg"
                  disabled={pending || selected.length === 0}
                  aria-busy={pending || undefined}
                  onClick={() => void archive()}
                >
                  {pending
                    ? 'Archiving…'
                    : selected.length > 0
                      ? `Archive ${sessionCount(selected.length)}`
                      : 'Archive selected'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {finishedCount !== null && finishedCount > 0 && (
        <ToastRegion>
          <Toast
            data-merged-cleanup-toast=""
            tone="success"
            title={`Finished ${sessionCount(finishedCount)}`}
            description="Worktrees removed and sessions archived. History is kept under Archived."
            onDismiss={() => setFinishedCount(null)}
            dismissLabel="Dismiss clean-up notice"
          />
        </ToastRegion>
      )}
      {batch && (
        <ToastRegion>
          <Toast
            data-session-cleanup-toast=""
            tone={batch.restoring ? 'loading' : 'success'}
            title={
              batch.restoring
                ? `Restoring ${sessionCount(batch.sessions.length)}…`
                : batch.sessions.length === batch.requested
                  ? `Archived ${sessionCount(batch.sessions.length)}`
                  : `Archived ${batch.sessions.length} of ${sessionCount(batch.requested)}`
            }
            description={
              batch.restoring
                ? undefined
                : 'History is kept. Find them under Archived.'
            }
            action={{
              label: 'Undo',
              disabled: batch.restoring,
              onClick: () => void undo(batch),
            }}
            onDismiss={dismissBatch}
            dismissLabel="Dismiss archive notice"
          />
        </ToastRegion>
      )}
    </>
  );
}
