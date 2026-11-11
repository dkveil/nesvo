import {
  previewOccurrences,
  type ScheduledJobDefinition,
} from '@nesvo/contracts';

export type {
  DesktopScheduledJob as ScheduledJob,
  DesktopScheduledJobRun as ScheduledJobRun,
} from '@nesvo/contracts';

export const previewSchedule = (
  { schedule, timeZone }: Pick<ScheduledJobDefinition, 'schedule' | 'timeZone'>,
  now = new Date(),
  count = 3,
) => previewOccurrences(schedule, now, timeZone, count);
