import {
  previewOccurrences,
  type DesktopScheduledJob as ScheduledJob,
  type DesktopScheduledJobRun as ScheduledJobRun,
  type ScheduledJobDefinition,
} from '@nesvo/contracts';
import type { Provider } from '@/entities/session';

export type {
  DesktopScheduledJob as ScheduledJob,
  DesktopScheduledJobRun as ScheduledJobRun,
} from '@nesvo/contracts';

export type JobProvider = ScheduledJob['provider'];
export type RunTone = 'success' | 'warning' | 'error' | 'muted' | 'info';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const weekdayNames = WEEKDAYS;

export const sessionProviders: Record<JobProvider, Provider> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const jobProviders: Record<Provider, JobProvider> = {
  'Claude Code': 'claude',
  Codex: 'codex',
};

export const runStatusLabels: Record<ScheduledJobRun['status'], string> = {
  starting: 'Starting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  skipped: 'Skipped',
  unavailable: 'Unavailable',
};

export const runTones: Record<ScheduledJobRun['status'], RunTone> = {
  starting: 'info',
  running: 'info',
  completed: 'success',
  failed: 'error',
  stopped: 'muted',
  interrupted: 'muted',
  skipped: 'muted',
  unavailable: 'warning',
};

export const toneText: Record<RunTone, string> = {
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-muted-foreground',
  info: 'text-info-foreground',
};

export const isActiveRun = (run: Pick<ScheduledJobRun, 'status'>) =>
  run.status === 'starting' || run.status === 'running';

export const runMoment = (run: ScheduledJobRun) =>
  run.startedAt ?? run.scheduledFor ?? run.finishedAt ?? '';

export const sortRuns = (runs: ScheduledJobRun[]) =>
  runs.toSorted(
    (left, right) =>
      runMoment(right).localeCompare(runMoment(left)) ||
      right.id.localeCompare(left.id),
  );

const clockTime = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));

export const runReasonLabel = (run: ScheduledJobRun) => {
  switch (run.reason) {
    case 'missed':
      return run.missedCount > 1 ? `${run.missedCount} missed` : 'Missed';
    case 'overlap':
      return 'Previous run still active';
    case 'busy':
      return 'Computer was busy';
    case 'limit':
      return run.resetAt
        ? `limit until ${clockTime(run.resetAt)}`
        : 'Account limit';
    case 'folder':
      return 'Folder unavailable';
    case 'catalog':
      return 'Model or effort unavailable';
    case 'timeout':
      return 'Time limit reached';
    case 'restart':
      return 'Nesvo closed during the run';
    default:
      return '';
  }
};

export const runSummary = (run: ScheduledJobRun) => {
  const reason = runReasonLabel(run);
  return reason
    ? `${runStatusLabels[run.status]} · ${reason}`
    : runStatusLabels[run.status];
};

export const scheduleSummary = ({
  schedule,
  timeZone,
}: Pick<ScheduledJobDefinition, 'schedule' | 'timeZone'>) => {
  const rule =
    schedule.kind === 'daily'
      ? `Daily ${schedule.time}`
      : schedule.kind === 'weekdays'
        ? `Weekdays ${schedule.time}`
        : schedule.kind === 'weekly'
          ? `${WEEKDAYS[schedule.weekday]}s ${schedule.time}`
          : schedule.minutes % 60 === 0
            ? `Every ${schedule.minutes / 60} h`
            : `Every ${schedule.minutes} min`;
  return `${rule} · ${timeZone}`;
};

export const formatUntil = (iso: string, now: number) => {
  const remaining = Date.parse(iso) - now;
  if (!Number.isFinite(remaining)) return '';
  if (remaining < MINUTE_MS) return 'in <1 min';
  if (remaining < HOUR_MS) return `in ${Math.round(remaining / MINUTE_MS)} min`;
  if (remaining < DAY_MS) return `in ${Math.round(remaining / HOUR_MS)} h`;
  return `in ${Math.round(remaining / DAY_MS)} d`;
};

export const formatOccurrence = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })
    .format(date)
    .replace(',', '');

export const formatRunTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

export const formatDuration = (run: ScheduledJobRun, now: number) => {
  if (!run.startedAt) return '';
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const elapsed = Math.max(0, end - Date.parse(run.startedAt));
  if (elapsed < MINUTE_MS)
    return `${Math.max(1, Math.round(elapsed / 1000))} s`;
  if (elapsed < HOUR_MS) return `${Math.round(elapsed / MINUTE_MS)} min`;
  return `${(elapsed / HOUR_MS).toFixed(1)} h`;
};

export const previewSchedule = (
  { schedule, timeZone }: Pick<ScheduledJobDefinition, 'schedule' | 'timeZone'>,
  now = new Date(),
  count = 3,
) => previewOccurrences(schedule, now, timeZone, count);
