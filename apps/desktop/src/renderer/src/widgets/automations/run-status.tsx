import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleStop,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import {
  runSummary,
  runTones,
  toneText,
  type ScheduledJobRun,
} from '@/entities/scheduled-job';

const runIcons: Record<ScheduledJobRun['status'], LucideIcon> = {
  starting: LoaderCircle,
  running: LoaderCircle,
  completed: CircleCheck,
  failed: CircleX,
  stopped: CircleStop,
  interrupted: CircleDashed,
  skipped: CircleSlash,
  unavailable: CircleAlert,
};

type Props = {
  run: ScheduledJobRun;
  className?: string;
};

export function RunStatus({ run, className }: Props) {
  const Icon = runIcons[run.status];
  const active = run.status === 'starting' || run.status === 'running';
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 font-medium',
        toneText[runTones[run.status]],
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0',
          active && 'animate-spin motion-reduce:animate-none',
        )}
      />
      <span className="truncate">{runSummary(run)}</span>
    </span>
  );
}
