import { cn } from '@/shared/lib/cn';
import { StatusIcon, type StatusKind } from '@/entities/status';
import {
  runSummary,
  runTones,
  toneText,
  type ScheduledJobRun,
} from '@/entities/scheduled-job';

const runStatusKinds: Record<ScheduledJobRun['status'], StatusKind> = {
  starting: 'running',
  running: 'running',
  completed: 'success',
  failed: 'error',
  stopped: 'idle',
  interrupted: 'idle',
  skipped: 'idle',
  unavailable: 'warning',
};

type Props = {
  run: ScheduledJobRun;
  className?: string;
};

export function RunStatus({ run, className }: Props) {
  const tone = runTones[run.status];
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 font-medium',
        toneText[tone],
        className,
      )}
    >
      <StatusIcon status={runStatusKinds[run.status]} tone={tone} />
      <span className="truncate">{runSummary(run)}</span>
    </span>
  );
}
