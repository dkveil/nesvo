import { CalendarClock, Pause, Play, Plus, Zap } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import {
  formatUntil,
  isActiveRun,
  type ScheduledJob,
  type ScheduledJobRun,
} from '@/entities/scheduled-job';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { DisabledHint } from '@/shared/ui/disabled-hint';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import { AddedByAssistantBadge } from '@/widgets/workflow-assistant/added-by-assistant-badge';
import { ComputerChip, FolderChip, ModelChip, ScheduleChip } from './job-chips';
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
  highlighted?: string[];
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
  highlighted = [],
}: Props) {
  const now = useNow(30_000);
  const activeCount = jobs.filter(job => job.active).length;
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <section
        aria-label="Automations"
        className="mx-auto w-full max-w-5xl px-5 py-4 xl:ml-5"
      >
        <div className="mb-3 flex items-center justify-between gap-3 px-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {jobs.length === 0
              ? 'No automations'
              : `${activeCount} active · ${jobs.length - activeCount} paused`}
          </span>
          <DisabledHint reason={createBlockedReason}>
            <Button
              type="button"
              variant="ghost"
              disabled={!!createBlockedReason}
              onClick={onCreate}
            >
              <Plus />
              New automation
            </Button>
          </DisabledHint>
        </div>
        {notices.map(notice => (
          <p key={notice} className="mb-2 px-2 text-2xs text-muted-foreground">
            {notice}
          </p>
        ))}
        {loading && jobs.length === 0 && (
          <SkeletonList
            label="Loading automations"
            density="two-line"
            rows={4}
          />
        )}
        {jobs.length > 0 ? (
          <ul className="divide-y divide-border/55">
            {jobs.map(job => {
              const key = entityKey(job);
              const run = latestRun(job);
              const computer = computers.find(item => item.id === job.hostId);
              const blocked = runBlockedReason(job);
              const busy = !!pending[key];
              const added = highlighted.includes(job.id);
              const offline = computer?.status !== 'connected';
              return (
                <li
                  key={key}
                  data-automation-id={job.id}
                  data-host-id={job.hostId}
                >
                  <ListRow
                    density="two-line"
                    className="[&>button>span:first-child]:h-7 [&>button>span:first-child]:self-start [&>button>span:last-child]:h-7 [&>button>span:last-child]:self-start [&>[data-slot=list-row-actions]]:mt-1 [&>[data-slot=list-row-actions]]:h-7 [&>[data-slot=list-row-actions]]:self-start"
                    leading={
                      <StatusDot tone={job.active ? 'success' : 'neutral'} />
                    }
                    title={
                      <span
                        data-automation-heading
                        className="flex h-7 min-w-0 items-center gap-2"
                      >
                        <span className="truncate">{job.name}</span>
                        {added && <AddedByAssistantBadge />}
                        <span className="text-ui font-normal text-muted-foreground">
                          {job.active && job.nextRunAt
                            ? `Next ${formatUntil(job.nextRunAt, now)}`
                            : 'Paused'}
                        </span>
                      </span>
                    }
                    description={
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <ScheduleChip job={job} />
                        <ComputerChip computer={computer} />
                        <FolderChip directory={job.directory} />
                        <ModelChip job={job} />
                      </span>
                    }
                    trailing={
                      <span className="flex items-center text-ui">
                        {run ? (
                          <RunStatus run={run} className="max-w-56 text-ui" />
                        ) : (
                          <span>No runs yet</span>
                        )}
                      </span>
                    }
                    actions={
                      <>
                        {added && !job.active && (
                          <Button
                            type="button"
                            size="xs"
                            variant="secondary"
                            aria-label={`Enable ${job.name}`}
                            disabled={busy || offline}
                            onClick={() => onSetActive(job, true)}
                          >
                            Enable
                          </Button>
                        )}
                        <DisabledHint reason={blocked}>
                          <IconButton
                            label={`Run ${job.name} now`}
                            tooltip={!blocked}
                            disabled={
                              busy || !!blocked || (run && isActiveRun(run))
                            }
                            onClick={() => onRunNow(job)}
                          >
                            <Zap />
                          </IconButton>
                        </DisabledHint>
                        <IconButton
                          label={
                            job.active
                              ? `Pause ${job.name}`
                              : `Resume ${job.name}`
                          }
                          disabled={busy || offline}
                          onClick={() => onSetActive(job, !job.active)}
                        >
                          {job.active ? <Pause /> : <Play />}
                        </IconButton>
                      </>
                    }
                    onClick={() => onOpen(job)}
                    mainProps={{ 'aria-label': `Open automation: ${job.name}` }}
                  />
                  {errors[key] && (
                    <StatusMessage tone="error" className="px-2 pb-1">
                      {errors[key]}
                    </StatusMessage>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          !loading && (
            <EmptyState
              icon={CalendarClock}
              title="No automations yet"
              description="Run a read-only prompt on a schedule. Results arrive in the Inbox for acceptance."
              action={
                <DisabledHint reason={createBlockedReason}>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!!createBlockedReason}
                    onClick={onCreate}
                  >
                    New automation
                  </Button>
                </DisabledHint>
              }
            />
          )
        )}
      </section>
    </ScrollArea>
  );
}
