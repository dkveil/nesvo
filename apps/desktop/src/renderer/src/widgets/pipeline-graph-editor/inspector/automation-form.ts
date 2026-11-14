import {
  SCHEDULE_TIME_PATTERN,
  SCHEDULED_JOB_MAX_INTERVAL_MINUTES,
  SCHEDULED_JOB_MIN_INTERVAL_MINUTES,
  saveScheduledJobSchema,
  scheduledJobLimits,
  type ScheduledJob,
} from '@nesvo/contracts';
import type { Provider } from '@/entities/session';
import { schemaNotes, type NotesByField } from './field-notes';
import type { AutomationInput } from './index';

export const scheduleKinds = [
  'weekdays',
  'daily',
  'weekly',
  'interval',
] as const;

export type ScheduleKind = (typeof scheduleKinds)[number];

export const scheduleKindLabels: Record<ScheduleKind, string> = {
  weekdays: 'Weekdays',
  daily: 'Daily',
  weekly: 'Weekly',
  interval: 'Interval',
};

export const weekdayLabels = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];

export type ScheduleValues = {
  name: string;
  specPath: string;
  kind: ScheduleKind;
  time: string;
  weekday: number;
  minutes: string;
  timeZone: string;
  provider: Provider;
  model: string;
  effort: string;
  timeoutMinutes: string;
};

export type JobProvider = ScheduledJob['provider'];

export const jobProviders: Record<Provider, JobProvider> = {
  'Claude Code': 'claude',
  Codex: 'codex',
};

export const sessionProviders: Record<JobProvider, Provider> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const DEFAULT_TIME = '09:00';
const DEFAULT_INTERVAL_MINUTES = 60;
const MINUTE_MS = 60_000;

export const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const listTimeZones = (current: string) => {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC'];
  }
  return zones.includes(current) ? zones : [current, ...zones];
};

export const initialScheduleValues = (
  pipelineName: string,
  specPath: string,
  provider: Provider,
  model: string,
): ScheduleValues => ({
  name: pipelineName ? `Run ${pipelineName}` : '',
  specPath,
  kind: 'weekdays',
  time: DEFAULT_TIME,
  weekday: 1,
  minutes: String(DEFAULT_INTERVAL_MINUTES),
  timeZone: localTimeZone(),
  provider,
  model,
  effort: '',
  timeoutMinutes: String(scheduledJobLimits.defaultTimeoutMinutes),
});

const wholeNumber = (value: string) =>
  /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;

const anchorNow = () =>
  new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS).toISOString();

const scheduleOf = (values: ScheduleValues) => {
  if (values.kind === 'interval')
    return {
      kind: 'interval' as const,
      minutes: wholeNumber(values.minutes),
      anchorAt: anchorNow(),
    };
  if (values.kind === 'weekly')
    return {
      kind: 'weekly' as const,
      weekday: values.weekday,
      time: values.time,
    };
  return { kind: values.kind, time: values.time };
};

export const automationInput = (
  values: ScheduleValues,
  id: string,
  directory: string,
  pipelineName: string,
): AutomationInput => {
  const provider = jobProviders[values.provider];
  return {
    id,
    name: values.name.trim(),
    prompt: '',
    directory,
    provider,
    model: values.model,
    effort: provider === 'codex' && values.effort ? values.effort : null,
    mode: 'read-only',
    schedule: scheduleOf(values),
    timeZone: values.timeZone,
    active: true,
    timeoutMinutes: wholeNumber(values.timeoutMinutes),
    pipeline: { name: pipelineName, specPath: values.specPath.trim() },
  };
};

const fieldOf = (path: PropertyKey[]) => {
  const [first, second] = path.map(String);
  if (first === 'schedule') return second ?? 'kind';
  if (first === 'pipeline') return second === 'name' ? 'form' : 'specPath';
  return first ?? 'form';
};

const between = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

const ownNotes = (values: ScheduleValues): NotesByField => {
  const notes: NotesByField = {};
  const error = (field: string, message: string) => {
    notes[field] = [{ severity: 'error', message }];
  };
  if (!values.name.trim()) error('name', 'Name the automation.');
  if (!values.specPath.trim())
    error('specPath', 'Choose a task spec or enter its path.');
  if (values.kind !== 'interval' && !SCHEDULE_TIME_PATTERN.test(values.time))
    error('time', 'Use a time such as 09:30.');
  if (
    values.kind === 'interval' &&
    !between(
      wholeNumber(values.minutes),
      SCHEDULED_JOB_MIN_INTERVAL_MINUTES,
      SCHEDULED_JOB_MAX_INTERVAL_MINUTES,
    )
  )
    error(
      'minutes',
      `Use ${SCHEDULED_JOB_MIN_INTERVAL_MINUTES} to ${SCHEDULED_JOB_MAX_INTERVAL_MINUTES} minutes.`,
    );
  if (!values.model) error('model', 'Choose a model.');
  if (
    !between(
      wholeNumber(values.timeoutMinutes),
      scheduledJobLimits.minTimeoutMinutes,
      scheduledJobLimits.maxTimeoutMinutes,
    )
  )
    error(
      'timeoutMinutes',
      `Use ${scheduledJobLimits.minTimeoutMinutes} to ${scheduledJobLimits.maxTimeoutMinutes} minutes.`,
    );
  return notes;
};

export const automationNotes = (
  values: ScheduleValues,
  input: AutomationInput,
): NotesByField => ({
  ...schemaNotes(
    saveScheduledJobSchema.safeParse({ ...input, expectedRevision: null }),
    fieldOf,
  ),
  ...ownNotes(values),
});

export const definitionOf = (job: ScheduledJob): AutomationInput => ({
  id: job.id,
  name: job.name,
  prompt: job.prompt,
  directory: job.directory,
  provider: job.provider,
  model: job.model,
  effort: job.effort,
  mode: job.mode,
  schedule: job.schedule,
  timeZone: job.timeZone,
  active: job.active,
  timeoutMinutes: job.timeoutMinutes,
  pipeline: job.pipeline,
});
