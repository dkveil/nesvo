import { CalendarClock, Pause, Play, Plus, Zap } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from 'cn';
import {
  formatUntil,
  isActiveRun,
  scheduleSummary,
  type ScheduledJob,
  type ScheduledJobRun,
} from '@/entities/scheduled-job';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { ComputerChip, FolderChip, ModelChip } from './job-chips';
import { RunStatus } from './run-status';

type Props = {
  jobs: ScheduledJob[];
  computers: Computer[];
  latestRun: (job: ScheduledJob) => ScheduledJobRun | undefined;
  loading: boolean;
  notices: string[];
  pending: Record<string, boolean>;
  errors: Record<string, string>;
  createBlockedReason: string;
  runBlockedReason: (job: ScheduledJob) => string;
  onCreate: () => void;
  onOpen: (job: ScheduledJob) => void;
  onRunNow: (job: ScheduledJob) => void;
  onSetActive: (job: ScheduledJob, active: boolean) => void;
};

export function AutomationList({
  jobs,
  computers,
  latestRun,
  loading,
  notices,
  pending,
  errors,
  createBlockedReason,
  runBlockedReason,
  onCreate,
  onOpen,
  onRunNow,
  onSetActive,
}: Props) {
  const now = useNow(30_000);
  const activeCount = jobs.filter(job => job.active).length;
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <section
        aria-label="Automations"
        className="mx-auto w-full max-w-4xl px-5 py-6 lg:px-8"
      >
        <div className="mb-3 flex items-center justify-between gap-3 px-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {jobs.length === 0
              ? 'No automations'
              : `${activeCount} active · ${jobs.length - activeCount} paused`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={!!createBlockedReason}
            title={createBlockedReason || 'New automation'}
            onClick={onCreate}
          >
            <Plus className="size-3.5" />
            New automation
          </Button>
        </div>
        {notices.map(notice => (
          <p key={notice} className="mb-2 px-3 text-2xs text-muted-foreground">
            {notice}
          </p>
        ))}
        {loading && jobs.length === 0 && (
          <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
            Loading automations…
          </p>
        )}
        {jobs.length > 0 ? (
          <ul className="space-y-px">
            {jobs.map(job => {
              const key = entityKey(job);
              const run = latestRun(job);
              const computer = computers.find(item => item.id === job.hostId);
              const blocked = runBlockedReason(job);
              const busy = !!pending[key];
              return (
                <li
                  key={key}
                  data-automation-id={job.id}
                  data-host-id={job.hostId}
                  className="group relative grid grid-cols-1 items-center gap-x-5 gap-y-2 rounded-lg px-3 py-2.5 transition-colors duration-100 focus-within:bg-accent hover:bg-accent md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          job.active
                            ? 'bg-success-foreground'
                            : 'bg-muted-foreground/50',
                        )}
                      />
                      <button
                        type="button"
                        className="min-w-0 truncate text-left text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                        aria-label={`Open automation: ${job.name}`}
                        onClick={() => onOpen(job)}
                      >
                        {job.name}
                      </button>
                    </div>
                    <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pl-3.5 text-2xs leading-4 text-muted-foreground">
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
                    </p>
                  </div>
                  <div className="flex min-w-0 items-center gap-3 pl-3.5 text-2xs md:pl-0">
                    <div className="flex min-w-0 flex-col items-start gap-0.5 md:items-end">
                      <span className="text-muted-foreground tabular-nums">
                        {job.active && job.nextRunAt
                          ? `Next ${formatUntil(job.nextRunAt, now)}`
                          : 'Paused'}
                      </span>
                      {run ? (
                        <RunStatus run={run} className="max-w-56" />
                      ) : (
                        <span className="text-muted-foreground">
                          No runs yet
                        </span>
                      )}
                    </div>
                    <div className="relative z-10 flex items-center gap-0.5 opacity-100 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 md:opacity-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 text-muted-foreground"
                        aria-label={`Run ${job.name} now`}
                        title={blocked || 'Run now'}
                        disabled={
                          busy || !!blocked || (run && isActiveRun(run))
                        }
                        onClick={() => onRunNow(job)}
                      >
                        <Zap className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 text-muted-foreground"
                        aria-label={
                          job.active
                            ? `Pause ${job.name}`
                            : `Resume ${job.name}`
                        }
                        title={job.active ? 'Pause' : 'Resume'}
                        disabled={busy || computer?.status !== 'connected'}
                        onClick={() => onSetActive(job, !job.active)}
                      >
                        {job.active ? (
                          <Pause className="size-3.5" />
                        ) : (
                          <Play className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {errors[key] && (
                    <p
                      role="alert"
                      className="col-span-full pl-3.5 text-xs text-destructive [overflow-wrap:anywhere]"
                    >
                      {errors[key]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          !loading && (
            <div className="flex min-h-80 flex-col items-center justify-center gap-2 text-center">
              <span className="mb-2 flex size-10 items-center justify-center rounded-xl border bg-card text-muted-foreground">
                <CalendarClock className="size-4.5" aria-hidden="true" />
              </span>
              <h2 className="text-[15px] font-semibold tracking-tight">
                No automations yet
              </h2>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                Run a read-only prompt on a schedule. Results arrive in the
                Inbox for acceptance.
              </p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2 h-7 text-xs"
                disabled={!!createBlockedReason}
                title={createBlockedReason || undefined}
                onClick={onCreate}
              >
                New automation
              </Button>
            </div>
          )
        )}
      </section>
    </ScrollArea>
  );
}
