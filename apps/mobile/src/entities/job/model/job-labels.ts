import type {
  JobCalendarState,
  JobOccurrence,
  JobOccurrenceState,
  JobRetryClass,
  JobRetryPolicy,
  JobSchedule,
  JobSummary,
} from '@shared/api/host';

export const JOB_OCCURRENCE_STATE_LABELS = {
  queued: 'Queued',
  dispatching: 'Starting',
  prechecking: 'Running precheck',
  running: 'Running',
  needsValidation: 'Result to validate',
  canceling: 'Canceling',
  retryWaiting: 'Waiting to retry',
  reconcile: 'Needs reconciliation',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  canceled: 'Canceled',
} as const satisfies Record<JobOccurrenceState, string>;

export const JOB_RETRY_CLASS_LABELS = {
  noEffect: 'No effect: the launch was refused before it started',
  uncertainEffect: 'Uncertain effect: probes looked for the launch',
} as const satisfies Record<JobRetryClass, string>;

const CALENDAR_STATE_LABELS = {
  ready: 'Scheduled',
  blocked: 'Schedule blocked',
  exhausted: 'No more automatic starts',
} as const satisfies Record<JobCalendarState, string>;

const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'Scheduled',
  manual: 'Run now',
  external: 'External trigger',
};

const FAILED_STATES = new Set<JobOccurrenceState>(['failed', 'reconcile']);
const ACTIVE_STATES = new Set<JobOccurrenceState>([
  'queued',
  'dispatching',
  'prechecking',
  'running',
  'canceling',
  'retryWaiting',
]);

export type JobTone = 'success' | 'danger' | 'warning' | 'muted';

export const occurrenceTone = (state: JobOccurrenceState): JobTone => {
  if (state === 'succeeded') return 'success';
  if (FAILED_STATES.has(state)) return 'danger';
  if (state === 'needsValidation' || ACTIVE_STATES.has(state)) return 'warning';
  return 'muted';
};

export const formatInstant = (at: number) => {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

export const scheduleLabel = (schedule: JobSchedule | null) => {
  if (!schedule) return 'This schedule needs a newer nesvo app';
  switch (schedule.kind) {
    case 'once':
      return `Once at ${schedule.at}`;
    case 'cron':
      return `Cron ${schedule.expression} (${schedule.timeZone})`;
    case 'rrule':
      return `${schedule.rule} from ${schedule.start} (${schedule.timeZone})`;
    case 'external':
      return 'External trigger only';
  }
};

export const jobStateLabel = ({ enabled, calendarState, nextDueAt }: JobSummary) => {
  if (!enabled) return 'Paused';
  if (calendarState === 'ready' && nextDueAt !== null)
    return `Next start ${formatInstant(nextDueAt)}`;
  return calendarState ? CALENDAR_STATE_LABELS[calendarState] : 'Schedule state unknown';
};

export const triggerLabel = (trigger: string) => TRIGGER_LABELS[trigger] ?? trigger;

export const attemptsLabel = (occurrence: JobOccurrence, policy: JobRetryPolicy | undefined) => {
  const limit = policy?.maxAttempts ?? 1;
  if (occurrence.jobAttemptOrdinal === null) return `No dispatch yet · up to ${limit}`;
  return `Attempt ${occurrence.jobAttemptOrdinal} of ${limit}`;
};

export const retryClassLabel = (occurrence: JobOccurrence, policy: JobRetryPolicy | undefined) => {
  if (!policy) return 'No retry policy';
  if (!occurrence.retry) return 'No retry decision';
  return occurrence.retry.class
    ? JOB_RETRY_CLASS_LABELS[occurrence.retry.class]
    : 'This retry class needs a newer nesvo app';
};
