import { useState } from 'react';
import {
  ArrowUpRight,
  Copy,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
  Zap,
} from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import {
  formatDuration,
  formatOccurrence,
  formatRunTime,
  isActiveRun,
  previewSchedule,
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
import { Badge } from '@/shared/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { IconButton } from '@/shared/ui/icon-button';
import { Label } from '@/shared/ui/label';
import { ListRow } from '@/shared/ui/list-row';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { Hint } from '@/shared/ui/tooltip';
import { ComputerChip, FolderChip, ModelChip, ScheduleChip } from './job-chips';
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
        <header className="space-y-3 px-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="truncate text-title font-semibold tracking-tight">
                {job.name}
              </h2>
              <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <ScheduleChip job={job} />
                <ComputerChip computer={computer} />
                <FolderChip directory={job.directory} />
                <ModelChip job={job} />
                <Hint
                  label={
                    job.provider === 'claude'
                      ? 'Claude Code can use Read, Glob and Grep only.'
                      : 'Codex runs in its read-only sandbox.'
                  }
                >
                  <Badge appearance="outline">
                    <Lock aria-hidden="true" />
                    Read-only
                  </Badge>
                </Hint>
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
                variant="secondary"
                disabled={pending || !!runBlockedReason || !!activeRun}
                title={runBlockedReason || undefined}
                onClick={onRunNow}
              >
                <Zap />
                Run now
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!!editBlockedReason}
                title={editBlockedReason || undefined}
                onClick={onEdit}
              >
                <Pencil />
                Edit
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label="More actions">
                    <MoreHorizontal />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    disabled={!!editBlockedReason}
                    onSelect={onDuplicate}
                  >
                    <Copy />
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!connected || !!activeRun}
                    onSelect={() => setConfirming(true)}
                  >
                    <Trash2 />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{nextRuns(job, now)}</p>
          <p className="line-clamp-3 rounded-surface border bg-card px-3 py-2 text-ui whitespace-pre-wrap text-card-foreground [overflow-wrap:anywhere]">
            {job.workflow
              ? `Workflow ${job.workflow.name} · ${job.workflow.specPath}`
              : job.prompt}
          </p>
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </header>
        <section aria-label="Runs" className="space-y-1">
          <SectionLabel>Runs</SectionLabel>
          {runsError && (
            <div className="flex flex-wrap items-center gap-3 px-2">
              <StatusMessage tone="error">{runsError}</StatusMessage>
              <Button variant="ghost" onClick={onRetryRuns}>
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
                  >
                    <ListRow
                      title={
                        <span className="flex min-w-0 items-center gap-2.5 text-xs">
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
                        </span>
                      }
                      trailing={
                        <span className="flex items-center gap-1">
                          {isActiveRun(run) && run.sessionId && (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
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
                              onClick={() =>
                                run.sessionId &&
                                onSession(hostKey(run.sessionId, run.hostId))
                              }
                            >
                              Open session
                              <ArrowUpRight />
                            </Button>
                          )}
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ol>
          ) : (
            !runsLoading &&
            !runsError && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No runs yet. Use Run now or wait for the schedule.
              </p>
            )
          )}
          {runsLoading && (
            <StatusMessage tone="loading" className="px-2 py-2">
              Loading runs…
            </StatusMessage>
          )}
          {hasMoreRuns && !runsLoading && (
            <Button type="button" variant="ghost" onClick={onLoadMore}>
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
              size="lg"
              type="button"
              variant="ghost"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              size="lg"
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
