import {
  SCHEDULE_TIME_PATTERN,
  SCHEDULED_JOB_MAX_INTERVAL_MINUTES,
  SCHEDULED_JOB_MIN_INTERVAL_MINUTES,
  isValidTimeZone,
  scheduledJobDefinitionSchema,
  scheduledJobLimits,
  type SaveScheduledJobInput,
  type ScheduledJobSchedule,
} from '@nesvo/contracts';
import {
  jobProviders,
  sessionProviders,
  type ScheduledJob,
} from '@/entities/scheduled-job';
import type { Provider } from '@/entities/session';

export type ScheduleKind = ScheduledJobSchedule['kind'];

export type AutomationValues = {
  id: string;
  hostId: string;
  name: string;
  prompt: string;
  directory: string;
  provider: Provider;
  model: string;
  effort: string;
  scheduleKind: ScheduleKind;
  time: string;
  weekday: number;
  minutes: string;
  anchorAt: string;
  timeZone: string;
  timeoutMinutes: string;
  active: boolean;
};

export type AutomationField =
  | 'name'
  | 'prompt'
  | 'model'
  | 'time'
  | 'minutes'
  | 'timeZone'
  | 'timeoutMinutes';

export type AutomationErrors = Partial<Record<AutomationField, string>>;

export const SKILL_PROMPT_MESSAGE =
  'Automation prompts are plain text. Skills (/name) are not supported yet.';

const DEFAULT_TIME = '09:00';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PROMPT_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DEFAULT_INTERVAL_MINUTES = '60';

export const detectedTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const currentMinute = () => {
  const now = new Date();
  now.setSeconds(0, 0);
  return now.toISOString();
};

export const newAutomationValues = (
  hostId: string,
  provider: Provider,
  model: string,
): AutomationValues => ({
  id: crypto.randomUUID(),
  hostId,
  name: '',
  prompt: '',
  directory: '',
  provider,
  model,
  effort: '',
  scheduleKind: 'weekdays',
  time: DEFAULT_TIME,
  weekday: 1,
  minutes: DEFAULT_INTERVAL_MINUTES,
  anchorAt: currentMinute(),
  timeZone: detectedTimeZone(),
  timeoutMinutes: String(scheduledJobLimits.defaultTimeoutMinutes),
  active: true,
});

export const automationValues = (job: ScheduledJob): AutomationValues => ({
  id: job.id,
  hostId: job.hostId,
  name: job.name,
  prompt: job.prompt,
  directory: job.directory,
  provider: sessionProviders[job.provider],
  model: job.model,
  effort: job.effort ?? '',
  scheduleKind: job.schedule.kind,
  time: job.schedule.kind === 'interval' ? DEFAULT_TIME : job.schedule.time,
  weekday: job.schedule.kind === 'weekly' ? job.schedule.weekday : 1,
  minutes:
    job.schedule.kind === 'interval'
      ? String(job.schedule.minutes)
      : DEFAULT_INTERVAL_MINUTES,
  anchorAt:
    job.schedule.kind === 'interval' ? job.schedule.anchorAt : currentMinute(),
  timeZone: job.timeZone,
  timeoutMinutes: String(job.timeoutMinutes),
  active: job.active,
});

export const duplicateValues = (job: ScheduledJob): AutomationValues => ({
  ...automationValues(job),
  id: crypto.randomUUID(),
  name: `${job.name} copy`.slice(0, scheduledJobLimits.name),
  active: false,
});

const wholeNumber = (value: string) =>
  /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;

export const scheduleOf = (
  values: AutomationValues,
): ScheduledJobSchedule | null => {
  if (values.scheduleKind === 'interval') {
    const minutes = wholeNumber(values.minutes);
    return Number.isInteger(minutes)
      ? { kind: 'interval', minutes, anchorAt: values.anchorAt }
      : null;
  }
  if (!SCHEDULE_TIME_PATTERN.test(values.time)) return null;
  if (values.scheduleKind === 'weekly')
    return { kind: 'weekly', weekday: values.weekday, time: values.time };
  return { kind: values.scheduleKind, time: values.time };
};

export const validateAutomation = (
  values: AutomationValues,
): AutomationErrors => {
  const errors: AutomationErrors = {};
  const name = values.name.trim();
  const prompt = values.prompt.trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > scheduledJobLimits.name)
    errors.name = `Use at most ${scheduledJobLimits.name} characters.`;
  else if (CONTROL_CHARACTERS.test(name))
    errors.name = 'Use a single line without control characters.';
  if (!prompt) errors.prompt = 'Enter a prompt.';
  else if (prompt.startsWith('/')) errors.prompt = SKILL_PROMPT_MESSAGE;
  else if (prompt.length > scheduledJobLimits.prompt)
    errors.prompt = `Use at most ${scheduledJobLimits.prompt} characters.`;
  else if (PROMPT_CONTROL_CHARACTERS.test(prompt))
    errors.prompt = 'Remove control characters from the prompt.';
  if (!values.model) errors.model = 'Choose a model.';
  if (values.scheduleKind === 'interval') {
    const minutes = wholeNumber(values.minutes);
    if (!Number.isInteger(minutes)) errors.minutes = 'Enter whole minutes.';
    else if (minutes < SCHEDULED_JOB_MIN_INTERVAL_MINUTES)
      errors.minutes = `Use at least ${SCHEDULED_JOB_MIN_INTERVAL_MINUTES} minutes.`;
    else if (minutes > SCHEDULED_JOB_MAX_INTERVAL_MINUTES)
      errors.minutes = `Use at most ${SCHEDULED_JOB_MAX_INTERVAL_MINUTES} minutes (one year).`;
  } else if (!SCHEDULE_TIME_PATTERN.test(values.time))
    errors.time = 'Use a time such as 09:00.';
  if (!isValidTimeZone(values.timeZone))
    errors.timeZone = 'Choose a valid time zone.';
  const timeout = wholeNumber(values.timeoutMinutes);
  if (
    !Number.isInteger(timeout) ||
    timeout < scheduledJobLimits.minTimeoutMinutes ||
    timeout > scheduledJobLimits.maxTimeoutMinutes
  )
    errors.timeoutMinutes = `Use ${scheduledJobLimits.minTimeoutMinutes} to ${scheduledJobLimits.maxTimeoutMinutes} minutes.`;
  return errors;
};

export const toSaveInput = (
  values: AutomationValues,
  effort: string,
): Omit<SaveScheduledJobInput, 'expectedRevision'> | string => {
  const schedule = scheduleOf(values);
  if (!schedule) return 'Check the schedule.';
  const definition = {
    name: values.name.trim(),
    prompt: values.prompt.trim(),
    directory: values.directory.trim(),
    provider: jobProviders[values.provider],
    model: values.model,
    effort: values.provider === 'Codex' && effort ? effort : null,
    mode: 'read-only' as const,
    schedule,
    timeZone: values.timeZone,
    active: values.active,
    timeoutMinutes: wholeNumber(values.timeoutMinutes),
  };
  const parsed = scheduledJobDefinitionSchema.safeParse(definition);
  if (!parsed.success)
    return `Check ${parsed.error.issues[0]?.path.join('.') || 'the settings'}.`;
  return { id: values.id, ...definition };
};
