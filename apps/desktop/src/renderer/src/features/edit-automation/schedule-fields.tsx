import { SCHEDULED_JOB_MIN_INTERVAL_MINUTES } from '@nesvo/contracts';
import {
  formatOccurrence,
  listTimeZones,
  previewSchedule,
  scheduleKindLabels,
  scheduleKinds,
  weekdayNames,
  weekdayOrder,
  type ScheduleKind,
} from '@/entities/scheduled-job';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/shared/ui/toggle-group';
import {
  scheduleOf,
  type AutomationErrors,
  type AutomationValues,
} from './automation-form';
import { FieldError } from './field-error';

type Props = {
  values: AutomationValues;
  errors: AutomationErrors;
  disabled: boolean;
  onChange: (patch: Partial<AutomationValues>) => void;
  onBlur: (field: 'time' | 'minutes' | 'timeZone') => void;
};

const timeZones = listTimeZones();

const isScheduleKind = (value: string): value is ScheduleKind =>
  scheduleKinds.some(kind => kind === value);

const previewText = (values: AutomationValues) => {
  const schedule = scheduleOf(values);
  if (!schedule) return '';
  try {
    return `Next: ${previewSchedule({ schedule, timeZone: values.timeZone })
      .map(date => formatOccurrence(date, values.timeZone))
      .join(', ')}`;
  } catch {
    return '';
  }
};

export function ScheduleFields({
  values,
  errors,
  disabled,
  onChange,
  onBlur,
}: Props) {
  const zones = timeZones.includes(values.timeZone)
    ? timeZones
    : [values.timeZone, ...timeZones];
  const preview = previewText(values);
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-2 text-xs font-medium">Schedule</legend>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="Repeat"
        className="w-full"
        value={values.scheduleKind}
        onValueChange={value => {
          if (isScheduleKind(value)) onChange({ scheduleKind: value });
        }}
      >
        {scheduleKinds.map(kind => (
          <ToggleGroupItem key={kind} value={kind} className="h-7 text-xs">
            {scheduleKindLabels[kind]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {values.scheduleKind === 'interval' ? (
        <div className="space-y-1.5">
          <Label htmlFor="automation-minutes" className="text-xs">
            Every N minutes (min {SCHEDULED_JOB_MIN_INTERVAL_MINUTES})
          </Label>
          <Input
            id="automation-minutes"
            data-field="minutes"
            inputMode="numeric"
            value={values.minutes}
            aria-invalid={!!errors.minutes}
            aria-describedby={
              errors.minutes ? 'automation-minutes-error' : undefined
            }
            onChange={event => onChange({ minutes: event.target.value })}
            onBlur={() => onBlur('minutes')}
            className="h-8 w-32 text-[13px]"
          />
          <FieldError id="automation-minutes-error" message={errors.minutes} />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          {values.scheduleKind === 'weekly' && (
            <div className="space-y-1.5">
              <Label htmlFor="automation-weekday" className="text-xs">
                Day
              </Label>
              <Select
                value={String(values.weekday)}
                onValueChange={value => onChange({ weekday: Number(value) })}
              >
                <SelectTrigger
                  id="automation-weekday"
                  size="sm"
                  className="w-36 text-[13px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {weekdayOrder.map(day => (
                    <SelectItem key={day} value={String(day)}>
                      {weekdayNames[day]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="automation-time" className="text-xs">
              Time
            </Label>
            <Input
              id="automation-time"
              data-field="time"
              type="time"
              value={values.time}
              aria-invalid={!!errors.time}
              aria-describedby={
                errors.time ? 'automation-time-error' : undefined
              }
              onChange={event => onChange({ time: event.target.value })}
              onBlur={() => onBlur('time')}
              className="h-8 w-28 text-[13px]"
            />
            <FieldError id="automation-time-error" message={errors.time} />
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="automation-time-zone" className="text-xs">
          Time zone
        </Label>
        <Select
          value={values.timeZone}
          onValueChange={value => {
            onChange({ timeZone: value });
            onBlur('timeZone');
          }}
        >
          <SelectTrigger
            id="automation-time-zone"
            data-field="timeZone"
            aria-describedby={
              errors.timeZone ? 'automation-time-zone-error' : undefined
            }
            size="sm"
            aria-invalid={!!errors.timeZone}
            className="w-full max-w-64 text-[13px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-72">
            {zones.map(zone => (
              <SelectItem key={zone} value={zone}>
                {zone}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError id="automation-time-zone-error" message={errors.timeZone} />
      </div>
      {preview && (
        <p
          role="status"
          className="text-2xs leading-4 text-muted-foreground tabular-nums"
        >
          {preview}
        </p>
      )}
      <p className="text-2xs leading-4 text-muted-foreground">
        Missed runs are skipped, never caught up.
      </p>
    </fieldset>
  );
}
