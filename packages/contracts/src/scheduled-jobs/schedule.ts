export const SCHEDULED_JOB_MIN_INTERVAL_MINUTES = 30;
export const SCHEDULED_JOB_MAX_INTERVAL_MINUTES = 525_600;
export const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const OCCURRENCE_SEARCH_DAYS = 8;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type ScheduleRule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'interval'; minutes: number; anchorAt: string };

export type MissedOccurrences = {
  scheduledFor: Date;
  nextRunAt: Date;
  skipped: number;
};

export type ScheduleErrorCode =
  'invalid-schedule' | 'invalid-time-zone' | 'invalid-date' | 'no-occurrence';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(
    code: ScheduleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (timeZone: string) => {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch (error) {
    throw new ScheduleError(
      'invalid-time-zone',
      `Unknown time zone "${timeZone}"`,
      { cause: error },
    );
  }
};

export const isValidTimeZone = (timeZone: string) => {
  try {
    getFormatter(timeZone);
    return true;
  } catch (error) {
    if (error instanceof ScheduleError) return false;
    throw error;
  }
};

const readWallClock = (instant: number, timeZone: string): WallClock => {
  const values: Record<string, number> = {};
  for (const part of getFormatter(timeZone).formatToParts(instant))
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
};

const wallClockAsUtc = (instant: number, timeZone: string) => {
  const wall = readWallClock(instant, timeZone);
  return Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
};

const offsetAt = (instant: number, timeZone: string) =>
  wallClockAsUtc(instant, timeZone) - Math.floor(instant / 1000) * 1000;

const findTransition = (guess: number, timeZone: string) => {
  const before = offsetAt(guess - DAY_MS, timeZone);
  let low = guess - DAY_MS;
  let high = guess + DAY_MS;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
    if (offsetAt(middle, timeZone) === before) low = middle;
    else high = middle;
  }
  return high;
};

const resolveWallTime = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
) => {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([
    offsetAt(guess - DAY_MS, timeZone),
    offsetAt(guess + DAY_MS, timeZone),
  ]);
  const matches = [...offsets]
    .map(offset => guess - offset)
    .filter(candidate => wallClockAsUtc(candidate, timeZone) === guess);
  if (matches.length > 0) return Math.min(...matches);
  return findTransition(guess, timeZone);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseTime = (time: unknown) => {
  const match =
    typeof time === 'string' ? SCHEDULE_TIME_PATTERN.exec(time) : null;
  if (!match)
    throw new ScheduleError(
      'invalid-schedule',
      `Invalid time "${String(time)}", expected HH:MM`,
    );
  return { hours: Number(match[1]), minutes: Number(match[2]) };
};

export function assertValidSchedule(
  schedule: unknown,
): asserts schedule is ScheduleRule {
  if (!isRecord(schedule))
    throw new ScheduleError('invalid-schedule', 'Schedule must be an object');
  if (schedule.kind === 'interval') {
    const { minutes, anchorAt } = schedule;
    if (
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes < SCHEDULED_JOB_MIN_INTERVAL_MINUTES ||
      minutes > SCHEDULED_JOB_MAX_INTERVAL_MINUTES
    )
      throw new ScheduleError(
        'invalid-schedule',
        `Interval needs whole minutes between ${SCHEDULED_JOB_MIN_INTERVAL_MINUTES} and ${SCHEDULED_JOB_MAX_INTERVAL_MINUTES}`,
      );
    if (typeof anchorAt !== 'string' || Number.isNaN(Date.parse(anchorAt)))
      throw new ScheduleError(
        'invalid-schedule',
        'Interval needs a valid anchor',
      );
    return;
  }
  if (
    schedule.kind !== 'daily' &&
    schedule.kind !== 'weekdays' &&
    schedule.kind !== 'weekly'
  )
    throw new ScheduleError(
      'invalid-schedule',
      `Unknown schedule kind "${String(schedule.kind)}"`,
    );
  parseTime(schedule.time);
  if (
    schedule.kind === 'weekly' &&
    !(
      typeof schedule.weekday === 'number' &&
      Number.isInteger(schedule.weekday) &&
      schedule.weekday >= 0 &&
      schedule.weekday <= 6
    )
  )
    throw new ScheduleError(
      'invalid-schedule',
      'Weekly needs a weekday from 0 (Sunday) to 6',
    );
}

const assertValidDate = (value: Date) => {
  if (!Number.isFinite(value.getTime()))
    throw new ScheduleError('invalid-date', 'Invalid date');
};

const matchesWeekday = (schedule: ScheduleRule, weekday: number) => {
  if (schedule.kind === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (schedule.kind === 'weekly') return weekday === schedule.weekday;
  return true;
};

export const nextOccurrence = (
  schedule: ScheduleRule,
  after: Date,
  timeZone: string,
): Date => {
  assertValidSchedule(schedule);
  assertValidDate(after);
  if (schedule.kind === 'interval') {
    const anchor = Date.parse(schedule.anchorAt);
    const step = schedule.minutes * MINUTE_MS;
    if (after.getTime() < anchor) return new Date(anchor);
    const steps = Math.floor((after.getTime() - anchor) / step) + 1;
    return new Date(anchor + steps * step);
  }
  const { hours, minutes } = parseTime(schedule.time);
  const today = readWallClock(after.getTime(), timeZone);
  for (let offset = 0; offset <= OCCURRENCE_SEARCH_DAYS; offset += 1) {
    const civilDay = new Date(
      Date.UTC(today.year, today.month - 1, today.day + offset),
    );
    if (!matchesWeekday(schedule, civilDay.getUTCDay())) continue;
    const candidate = resolveWallTime(
      civilDay.getUTCFullYear(),
      civilDay.getUTCMonth() + 1,
      civilDay.getUTCDate(),
      hours,
      minutes,
      timeZone,
    );
    if (candidate > after.getTime()) return new Date(candidate);
  }
  throw new ScheduleError(
    'no-occurrence',
    `No occurrence found in the next ${OCCURRENCE_SEARCH_DAYS} days`,
  );
};

export const collapseMissed = (
  schedule: ScheduleRule,
  from: Date,
  now: Date,
  timeZone: string,
): MissedOccurrences => {
  let scheduledFor = from;
  let nextRunAt = nextOccurrence(schedule, scheduledFor, timeZone);
  let skipped = 0;
  while (nextRunAt.getTime() <= now.getTime()) {
    scheduledFor = nextRunAt;
    nextRunAt = nextOccurrence(schedule, scheduledFor, timeZone);
    skipped += 1;
  }
  return { scheduledFor, nextRunAt, skipped };
};

export const describeSchedule = (schedule: ScheduleRule) => {
  assertValidSchedule(schedule);
  if (schedule.kind === 'daily') return `Every day at ${schedule.time}`;
  if (schedule.kind === 'weekdays') return `Weekdays at ${schedule.time}`;
  if (schedule.kind === 'weekly')
    return `Every ${WEEKDAY_NAMES[schedule.weekday]} at ${schedule.time}`;
  if (schedule.minutes % 60 === 0) {
    const hours = schedule.minutes / 60;
    return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
  }
  return `Every ${schedule.minutes} minutes`;
};

export const previewOccurrences = (
  schedule: ScheduleRule,
  now: Date,
  timeZone: string,
  count = 3,
): Date[] => {
  const occurrences: Date[] = [];
  let cursor = now;
  for (let index = 0; index < count; index += 1) {
    cursor = nextOccurrence(schedule, cursor, timeZone);
    occurrences.push(cursor);
  }
  return occurrences;
};
