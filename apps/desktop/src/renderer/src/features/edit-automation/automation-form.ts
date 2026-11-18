import {
  SCHEDULE_TIME_PATTERN,
  SCHEDULED_JOB_MAX_INTERVAL_MINUTES,
  SCHEDULED_JOB_MIN_INTERVAL_MINUTES,
  isValidTimeZone,
  scheduledJobDefinitionSchema,
  scheduledJobChangeTriggerSchema,
  scheduledJobLimits,
  type SaveScheduledJobInput,
  type ScheduledJobSchedule,
} from '@nesvo/contracts';
import {
  jobProviders,
  localTimeZone,
  sessionProviders,
  type ScheduleKind,
  type ScheduledJob,
} from '@/entities/scheduled-job';
import type { Provider } from '@/entities/session';

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
  workflow: ScheduledJob['workflow'];
  checkEnabled: boolean;
  checkCommand: string;
  dailyRunCap: string;
  askFirst: boolean;
  reviewMode: boolean;
  reviewProfileId: string;
  writable: boolean;
  browser: boolean;
  redCi: boolean;
};

export type AutomationField =
  | 'name'
  | 'prompt'
  | 'model'
  | 'time'
  | 'minutes'
  | 'timeZone'
  | 'timeoutMinutes'
  | 'checkCommand'
  | 'dailyRunCap'
  | 'review'
  | 'workspace'
  | 'browser';

export type AutomationErrors = Partial<Record<AutomationField, string>>;

export const REVIEW_CHECK_COMMAND =
  '["gh", "pr", "list", "--state", "open", "--json", "number,headRefOid"]';

export const SKILL_PROMPT_MESSAGE =
  'Automation prompts are plain text. Skills (/name) are not supported yet.';

const DEFAULT_TIME = '09:00';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PROMPT_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DEFAULT_INTERVAL_MINUTES = '60';

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
  timeZone: localTimeZone(),
  timeoutMinutes: String(scheduledJobLimits.defaultTimeoutMinutes),
  active: true,
  workflow: null,
  checkEnabled: false,
  checkCommand: '',
  dailyRunCap: String(scheduledJobLimits.defaultDailyRunCap),
  askFirst: true,
  reviewMode: false,
  reviewProfileId: '',
  writable: false,
  browser: false,
  redCi: false,
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
  workflow: job.workflow,
  checkEnabled: !!job.changeTrigger,
  checkCommand: job.changeTrigger ? JSON.stringify(job.changeTrigger.argv) : '',
  dailyRunCap: String(
    job.redCi?.dailyRunCap ??
      job.changeTrigger?.dailyRunCap ??
      scheduledJobLimits.defaultDailyRunCap,
  ),
  askFirst: job.changeTrigger?.askFirst ?? true,
  reviewMode: !!job.pullRequestReview,
  reviewProfileId: job.pullRequestReview?.profileId ?? '',
  writable: job.mode !== 'read-only',
  browser: !!job.browser,
  redCi: !!job.redCi,
});

export const duplicateValues = (job: ScheduledJob): AutomationValues => ({
  ...automationValues(job),
  id: crypto.randomUUID(),
  name: `${job.name} copy`.slice(0, scheduledJobLimits.name),
  active: false,
});

const wholeNumber = (value: string) =>
  /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;

const checkArguments = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

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
  if (values.reviewMode) {
    if (!values.reviewProfileId) errors.review = 'Choose a reviewer profile.';
    else if (!values.directory.trim())
      errors.review = 'Choose a checkout of the repository to review.';
  } else if (!prompt) {
    if (!values.workflow) errors.prompt = 'Enter a prompt.';
  } else if (prompt.startsWith('/')) errors.prompt = SKILL_PROMPT_MESSAGE;
  else if (prompt.length > scheduledJobLimits.prompt)
    errors.prompt = `Use at most ${scheduledJobLimits.prompt} characters.`;
  else if (PROMPT_CONTROL_CHARACTERS.test(prompt))
    errors.prompt = 'Remove control characters from the prompt.';
  if (!values.model) errors.model = 'Choose a model.';
  if (
    values.writable &&
    !values.redCi &&
    values.active &&
    !values.directory.trim()
  )
    errors.workspace = 'Choose a repository checkout for the worktree.';
  if (
    values.browser &&
    values.active &&
    (!values.workflow?.name ||
      !values.workflow.specPath ||
      !values.directory.trim())
  )
    errors.browser =
      'Choose a folder and supply the global workflow name and the task spec path.';
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
  if (values.checkEnabled) {
    if (!values.directory.trim())
      errors.checkCommand = 'Choose a folder for the check command.';
    else if (
      !scheduledJobChangeTriggerSchema.shape.argv.safeParse(
        checkArguments(values.checkCommand),
      ).success
    )
      errors.checkCommand =
        'Enter a JSON array with an executable and up to 31 arguments.';
  }
  if (values.checkEnabled || values.redCi) {
    const cap = wholeNumber(values.dailyRunCap);
    if (
      !Number.isInteger(cap) ||
      cap < 1 ||
      cap > scheduledJobLimits.maxDailyRunCap
    )
      errors.dailyRunCap = `Use 1 to ${scheduledJobLimits.maxDailyRunCap} runs.`;
  }
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
    prompt: values.reviewMode ? '' : values.prompt.trim(),
    directory: values.redCi ? '' : values.directory.trim(),
    provider: jobProviders[values.provider],
    model: values.model,
    effort: values.provider === 'Codex' && effort ? effort : null,
    mode:
      values.writable && !values.workflow && !values.reviewMode
        ? values.provider === 'Codex'
          ? 'supervised'
          : 'accept-edits'
        : 'read-only',
    schedule,
    timeZone: values.timeZone,
    active: values.active,
    timeoutMinutes: wholeNumber(values.timeoutMinutes),
    workflow:
      values.workflow?.name && values.workflow.specPath
        ? values.workflow
        : null,
    ...(values.browser ? { browser: true } : {}),
    ...(values.redCi
      ? { redCi: { dailyRunCap: wholeNumber(values.dailyRunCap) } }
      : {}),
    ...(values.reviewMode && values.reviewProfileId
      ? { pullRequestReview: { profileId: values.reviewProfileId } }
      : {}),
    ...(values.checkEnabled
      ? {
          changeTrigger: {
            argv: checkArguments(values.checkCommand),
            dailyRunCap: wholeNumber(values.dailyRunCap),
            askFirst: values.askFirst,
          },
        }
      : {}),
  };
  const parsed = scheduledJobDefinitionSchema.safeParse(definition);
  if (!parsed.success)
    return parsed.error.issues[0]?.message ?? 'Check the automation settings.';
  return { id: values.id, ...parsed.data };
};
