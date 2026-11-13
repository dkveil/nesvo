import { useState } from 'react';
import {
  ArrowUpRight,
  CalendarClock,
  Copy,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
  Zap,
} from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from 'cn';
import {
  formatDuration,
  formatOccurrence,
  formatRunTime,
  isActiveRun,
  previewSchedule,
  scheduleSummary,
  type ScheduledJob,
  type ScheduledJobRun,
} from '@/entities/scheduled-job';
import type { Review } from '@/entities/review';
import { hostKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Label } from '@/shared/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Switch } from '@/shared/ui/switch';
import { ComputerChip, FolderChip, ModelChip } from './job-chips';
import { RunStatus } from './run-status';

type Props = {
  job: ScheduledJob;
  computer: Computer | undefined;
  runs: ScheduledJobRun[];
  runsLoading: boolean;
  runsError: string;
  hasMoreRuns: boolean;
  reviews: Review[];
  pending: boolean;
  error: string;
  runBlockedReason: string;
  editBlockedReason: string;
  onRunNow: () => void;
  onSetActive: (active: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => Promise<boolean>;
  onStop: (run: ScheduledJobRun) => void;
  onSession: (sessionKey: string) => void;
  onLoadMore: () => void;
  onRetryRuns: () => void;
};

const reviewStates: Record<Review['status'], string> = {
  pending: 'Waiting for acceptance',
  accepted: 'Accepted',
  'changes-requested': 'Corrected',
  rejected: 'Rejected',
  superseded: 'Corrected',
};

const nextRuns = (job: ScheduledJob, now: number) => {
  if (!job.active) return 'Paused. Turn it on to schedule the next run.';
  try {
    return `Next: ${previewSchedule(job, new Date(now))
      .map(date => formatOccurrence(date, job.timeZone))
      .join(', ')}`;
  } catch {
    return '';
  }
};

export function AutomationDetail({
  job,
  computer,
  runs,
  runsLoading,
  runsError,
  hasMoreRuns,
  reviews,
  pending,
  error,
  runBlockedReason,
  editBlockedReason,
  onRunNow,
  onSetActive,
  onEdit,
  onDuplicate,
  onDelete,
  onStop,
  onSession,
  onLoadMore,
  onRetryRuns,
}: Props) {
  const now = useNow(30_000);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const activeRun = runs.find(isActiveRun);
  const connected = computer?.status === 'connected';
  const reviewOf = (run: ScheduledJobRun) =>
    run.reviewId
      ? reviews.find(
          review => review.id === run.reviewId && review.hostId === run.hostId,
        )
      : undefined;
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <section
        aria-label={`Automation: ${job.name}`}
        data-automation-id={job.id}
        className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 lg:px-8"
      >
        <header className="space-y-3 px-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="truncate text-lg font-semibold tracking-tight">
                {job.name}
              </h2>
              <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <CalendarClock
                    className="size-3 shrink-0"
                    aria-hidden="true"
                  />
                  {scheduleSummary(job)}
                </span>
                <ComputerChip computer={computer} />
                <FolderChip directory={job.directory} />
                <ModelChip job={job} />
                <span
                  className="inline-flex items-center gap-1 rounded-sm border px-1.5 text-2xs leading-4 font-medium text-foreground"
                  title={
                    job.provider === 'claude'
                      ? 'Claude Code can use Read, Glob and Grep only.'
                      : 'Codex runs in its read-only sandbox.'
                  }
                >
                  <Lock className="size-2.5" aria-hidden="true" />
                  Read-only
                </span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <div className="flex items-center gap-2 pr-1">
                <Switch
                  id="automation-active"
                  checked={job.active}
                  disabled={pending || !connected}
                  onCheckedChange={onSetActive}
                />
                <Label
                  htmlFor="automation-active"
                  className="text-xs text-muted-foreground"
                >
                  Active
                </Label>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={pending || !!runBlockedReason || !!activeRun}
                title={runBlockedReason || 'Run now'}
                onClick={onRunNow}
              >
                <Zap className="size-3.5" />
                Run now
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={!!editBlockedReason}
                title={editBlockedReason || 'Edit'}
                onClick={onEdit}
              >
                <Pencil className="size-3.5" />
                Edit
              </Button>
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="size-7 text-muted-foreground"
                    aria-label="More actions"
                    title="More actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-1">
                  <button
                    type="button"
                    disabled={!!editBlockedReason}
                    className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none hover:bg-highlight focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      setMenuOpen(false);
                      onDuplicate();
                    }}
                  >
                    <Copy className="size-3.5 text-muted-foreground" />
                    Duplicate
                  </button>
                  <button
                    type="button"
                    disabled={!connected || !!activeRun}
                    className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-destructive outline-none hover:bg-highlight focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirming(true);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{nextRuns(job, now)}</p>
          <p className="line-clamp-3 rounded-lg border bg-card px-3 py-2 text-[13px] leading-5 whitespace-pre-wrap text-card-foreground [overflow-wrap:anywhere]">
            {job.prompt}
          </p>
          {error && (
            <p
              role="alert"
              className="text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
        </header>
        <section aria-label="Runs" className="space-y-1">
          <h3 className="px-3 text-xs font-medium text-muted-foreground">
            Runs
          </h3>
          {runsError && (
            <div className="flex flex-wrap items-center gap-3 px-3">
              <p
                role="alert"
                className="text-xs text-destructive [overflow-wrap:anywhere]"
              >
                {runsError}
              </p>
              <Button size="sm" variant="ghost" onClick={onRetryRuns}>
                Retry
              </Button>
            </div>
          )}
          {runs.length > 0 ? (
            <ol className="space-y-px">
              {runs.map(run => {
                const review = reviewOf(run);
                const at = run.startedAt ?? run.scheduledFor ?? run.finishedAt;
                const duration = formatDuration(run, now);
                return (
                  <li
                    key={run.id}
                    data-run-id={run.id}
                    data-run-status={run.status}
                    className="grid grid-cols-1 items-center gap-x-4 gap-y-1 rounded-lg px-3 py-2 text-xs transition-colors duration-100 hover:bg-accent md:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                      <RunStatus run={run} />
                      <span className="text-muted-foreground">
                        {run.trigger === 'manual' ? 'Run now' : 'Scheduled'}
                      </span>
                      {at && (
                        <time
                          dateTime={at}
                          className="text-muted-foreground tabular-nums"
                        >
                          {formatRunTime(at)}
                        </time>
                      )}
                      {duration && (
                        <span className="text-muted-foreground tabular-nums">
                          {duration}
                        </span>
                      )}
                      {review && (
                        <span
                          className={cn(
                            'text-muted-foreground',
                            review.status === 'pending' &&
                              'text-warning-foreground',
                          )}
                        >
                          {reviewStates[review.status]}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {isActiveRun(run) && run.sessionId && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="h-6 rounded-full px-2 text-xs"
                          disabled={!connected}
                          onClick={() => onStop(run)}
                        >
                          Stop
                        </Button>
                      )}
                      {run.sessionId && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                          onClick={() =>
                            run.sessionId &&
                            onSession(hostKey(run.sessionId, run.hostId))
                          }
                        >
                          Open session
                          <ArrowUpRight className="size-3" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            !runsLoading &&
            !runsError && (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                No runs yet. Use Run now or wait for the schedule.
              </p>
            )
          )}
          {runsLoading && (
            <p
              role="status"
              className="px-3 py-2 text-xs text-muted-foreground"
            >
              Loading runs…
            </p>
          )}
          {hasMoreRuns && !runsLoading && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mx-1 h-7 text-xs text-muted-foreground"
              onClick={onLoadMore}
            >
              Show older runs
            </Button>
          )}
        </section>
      </section>
      <Dialog
        open={confirming}
        onOpenChange={open => {
          if (!deleting) setConfirming(open);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {job.name}?</DialogTitle>
            <DialogDescription>
              Its schedule and run history are removed. Sessions and results it
              created stay in your history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                const deleted = await onDelete();
                setDeleting(false);
                if (!deleted) setConfirming(false);
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}
