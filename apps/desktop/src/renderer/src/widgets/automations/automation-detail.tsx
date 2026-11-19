import { useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Clock,
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
import { modeLabel } from '@/entities/session';
import { StatusIcon } from '@/entities/status';
import { hostKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Badge } from '@/shared/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { DisabledHint } from '@/shared/ui/disabled-hint';
import { IconButton } from '@/shared/ui/icon-button';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { Label } from '@/shared/ui/label';
import { ListRow } from '@/shared/ui/list-row';
import { PanelBody } from '@/shared/ui/panel';
import {
  SidePanel,
  SidePanelFooter,
  SidePanelHeader,
} from '@/shared/ui/side-panel';
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
  onInbox: () => void;
  onSetActive: (active: boolean) => void;
  onEdit: () => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => Promise<boolean>;
  onStop: (run: ScheduledJobRun) => void;
  onSession: (sessionKey: string) => void;
  onLoadMore: () => void;
  onRetryRuns: () => void;
};

const reviewStates: Record<Review['status'], string> = {
  done: 'Done',
  pending: 'Waiting for acceptance',
  accepted: 'Accepted',
  'changes-requested': 'Corrected',
  rejected: 'Rejected',
  superseded: 'Corrected',
};

const checkStatuses = {
  changed: { label: 'Changed', icon: 'success' },
  unchanged: { label: 'Unchanged', icon: 'idle' },
  failed: { label: 'Failed', icon: 'error' },
} as const;

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

const runProblem = (run: ScheduledJobRun) =>
  run.detail ||
  (run.status === 'interrupted'
    ? 'The run ended before it reported a result. Open the session to check its last activity.'
    : run.status === 'failed'
      ? 'The run did not complete. Open the session to see what failed.'
      : '');

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
  onInbox,
  onSetActive,
  onEdit,
  onClose,
  onDuplicate,
  onDelete,
  onStop,
  onSession,
  onLoadMore,
  onRetryRuns,
}: Props) {
  const now = useNow(30_000);
  const [confirming, setConfirming] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const activeRun = runs.find(isActiveRun);
  const check = job.lastCheck;
  const checkStatus = check && checkStatuses[check.status];
  const dailyRunCap = job.redCi?.dailyRunCap ?? job.changeTrigger?.dailyRunCap;
  const connected = computer?.status === 'connected';
  const reviewOf = (run: ScheduledJobRun) =>
    run.reviewId
      ? reviews.find(
          review => review.id === run.reviewId && review.hostId === run.hostId,
        )
      : undefined;
  const selectedRun = runs.find(run => run.id === runId);
  const selectedReview = selectedRun && reviewOf(selectedRun);
  const selectedSession = selectedRun?.sessionId
    ? hostKey(selectedRun.sessionId, selectedRun.hostId)
    : null;
  if (selectedRun) {
    const at =
      selectedRun.startedAt ??
      selectedRun.scheduledFor ??
      selectedRun.finishedAt;
    const duration = formatDuration(selectedRun, now);
    return (
      <SidePanel
        key={selectedRun.id}
        kind="automation"
        resizeLabel="Resize automation panel"
        aria-label="Automation run"
        focusOnOpen
        onEscape={onClose}
      >
        <SidePanelHeader
          icon={Clock}
          title="Automation run"
          meta={job.name}
          closeLabel="Close automation"
          onClose={onClose}
        >
          <IconButton label="Back to automation" onClick={() => setRunId(null)}>
            <ArrowLeft />
          </IconButton>
        </SidePanelHeader>
        <PanelBody className="space-y-3 overscroll-contain p-3">
          <RunStatus run={selectedRun} className="text-ui" />
          <KeyValueList
            entries={[
              {
                key: 'trigger',
                label: 'Trigger',
                value:
                  selectedRun.trigger === 'manual' ? 'Run now' : 'Scheduled',
              },
              ...(at
                ? [
                    {
                      key: 'time',
                      label: 'Run time',
                      value: <time dateTime={at}>{formatRunTime(at)}</time>,
                    },
                  ]
                : []),
              ...(duration
                ? [{ key: 'duration', label: 'Duration', value: duration }]
                : []),
              ...(selectedReview
                ? [
                    {
                      key: 'review',
                      label: 'Review',
                      value: reviewStates[selectedReview.status],
                    },
                  ]
                : []),
            ]}
          />
          {runProblem(selectedRun) && (
            <StatusMessage
              tone={selectedRun.status === 'interrupted' ? 'warning' : 'error'}
            >
              {runProblem(selectedRun)}
            </StatusMessage>
          )}
          {selectedRun.report && (
            <section
              aria-label="Run report"
              className="space-y-2 border-t pt-3"
            >
              <SectionLabel className="px-0">Report</SectionLabel>
              <p className="text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
                {selectedRun.report}
              </p>
              {selectedRun.changes && (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    {selectedRun.changes.summaryChanged
                      ? 'Changed since the previous run'
                      : 'No change since the previous run'}
                  </p>
                  {selectedRun.changes.added.map(item => (
                    <p key={item}>New: {item}</p>
                  ))}
                  {selectedRun.changes.resolved.map(item => (
                    <p key={item}>Resolved: {item}</p>
                  ))}
                </div>
              )}
            </section>
          )}
        </PanelBody>
        {selectedSession && (
          <SidePanelFooter label="Run actions" className="justify-end gap-2">
            {isActiveRun(selectedRun) &&
              (selectedRun.runId || selectedRun.workflowRunId) && (
                <Button
                  variant="outline"
                  disabled={!connected}
                  onClick={() => onStop(selectedRun)}
                >
                  Stop
                </Button>
              )}
            <Button
              variant="secondary"
              onClick={() => onSession(selectedSession)}
            >
              Open session <ArrowUpRight />
            </Button>
          </SidePanelFooter>
        )}
      </SidePanel>
    );
  }
  return (
    <SidePanel
      key={job.id}
      kind="automation"
      resizeLabel="Resize automation panel"
      aria-label={`Automation: ${job.name}`}
      data-automation-id={job.id}
      focusOnOpen
      onEscape={onClose}
    >
      <SidePanelHeader
        icon={Clock}
        title={job.name}
        closeLabel="Close automation"
        onClose={onClose}
      />
      <PanelBody className="space-y-4 overscroll-contain p-3">
        <header className="space-y-3 px-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <ScheduleChip job={job} />
                <ComputerChip computer={computer} />
                <FolderChip directory={job.directory} />
                <ModelChip job={job} />
                <Hint
                  label={
                    job.mode !== 'read-only'
                      ? 'Uses a separate worktree and the selected provider’s permissions.'
                      : job.provider === 'claude'
                        ? 'Claude Code can use Read, Glob and Grep only.'
                        : 'Codex runs in its read-only sandbox.'
                  }
                >
                  <Badge appearance="outline">
                    <Lock aria-hidden="true" />
                    {modeLabel(
                      job.provider === 'claude' ? 'Claude Code' : 'Codex',
                      job.mode,
                    )}
                  </Badge>
                </Hint>
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{nextRuns(job, now)}</p>
          {dailyRunCap !== undefined && (
            <KeyValueList
              entries={[
                {
                  key: 'last-check',
                  label: job.redCi ? 'Pull request checks' : 'Last check',
                  value:
                    check && checkStatus ? (
                      <span className="flex flex-wrap items-center gap-x-2">
                        <StatusIcon status={checkStatus.icon} />
                        {job.redCi && check.status !== 'failed'
                          ? check.status === 'changed'
                            ? 'Failing checks found'
                            : 'No new failing heads'
                          : checkStatus.label}
                        <time
                          dateTime={check.at}
                          className="text-muted-foreground"
                        >
                          {formatRunTime(check.at)}
                        </time>
                        {check.detail && (
                          <span className="text-muted-foreground">
                            {check.detail}
                          </span>
                        )}
                      </span>
                    ) : (
                      'Waiting for the first check'
                    ),
                },
                {
                  key: 'daily-cap',
                  label: 'Daily run cap',
                  value: dailyRunCap,
                },
                ...(job.pendingStart
                  ? [
                      {
                        key: 'pending-start',
                        label: 'Start request',
                        value: (
                          <Button
                            variant="link"
                            size="inline"
                            onClick={onInbox}
                          >
                            Open Inbox
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          <p className="line-clamp-3 px-2 text-ui whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
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
            <ol className="divide-y divide-border/55">
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
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui">
                          <RunStatus run={run} className="text-ui" />
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
                                'text-xs font-medium text-muted-foreground',
                                review.status === 'pending' &&
                                  'text-warning-foreground',
                              )}
                            >
                              {reviewStates[review.status]}
                            </span>
                          )}
                          {run.sessionId && (
                            <Button
                              type="button"
                              size="inline"
                              variant="link"
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
                      actionsPlacement="visible"
                      actions={
                        <span className="flex items-center gap-1">
                          <IconButton
                            label="Open run details"
                            onClick={() => setRunId(run.id)}
                          >
                            <ArrowUpRight />
                          </IconButton>
                          {isActiveRun(run) &&
                            run.sessionId &&
                            (run.runId || run.workflowRunId) && (
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
                        </span>
                      }
                    />
                    {runProblem(run) && (
                      <StatusMessage
                        tone={
                          run.status === 'interrupted' ? 'warning' : 'error'
                        }
                        className="px-3 pb-2"
                      >
                        {runProblem(run)}
                      </StatusMessage>
                    )}
                    {run.report && (
                      <p className="line-clamp-2 px-3 pb-2 text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                        {run.report}
                      </p>
                    )}
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
      </PanelBody>
      <SidePanelFooter label="Automation actions" className="justify-end gap-2">
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
        <DisabledHint reason={runBlockedReason}>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !!runBlockedReason || !!activeRun}
            onClick={onRunNow}
          >
            <Zap />
            Run now
          </Button>
        </DisabledHint>
        <DisabledHint reason={editBlockedReason}>
          <Button
            type="button"
            variant="ghost"
            disabled={!!editBlockedReason}
            onClick={onEdit}
          >
            <Pencil />
            {job.profileOwnership ? 'Edit profile setting' : 'Edit'}
          </Button>
        </DisabledHint>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="More actions">
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={!!editBlockedReason || !!job.profileOwnership}
              onSelect={onDuplicate}
            >
              <Copy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!connected || !!activeRun || !!job.profileOwnership}
              onSelect={() => setConfirming(true)}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidePanelFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${job.name}?`}
        description="Its schedule and run history are removed. Sessions and results it created stay in your history."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        onConfirm={onDelete}
      />
    </SidePanel>
  );
}
