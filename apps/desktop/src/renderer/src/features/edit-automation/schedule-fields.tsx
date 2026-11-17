import { SCHEDULED_JOB_MIN_INTERVAL_MINUTES } from '@nesvo/contracts';
import {
  formatOccurrence,
  listTimeZones,
  previewSchedule,
  weekdayNames,
  weekdayOrder,
} from '@/entities/scheduled-job';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import {
  scheduleOf,
  type AutomationErrors,
  type AutomationValues,
} from './automation-form';
import { errorMessages, messagesId } from './field-messages';
import { RepeatField } from './repeat-field';

type Props = {
  values: AutomationValues;
  errors: AutomationErrors;
  disabled: boolean;
  onChange: (patch: Partial<AutomationValues>) => void;
  onBlur: (field: 'time' | 'minutes' | 'timeZone') => void;
};

const timeZones = listTimeZones();

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
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">Schedule</legend>
      <RepeatField
        id="automation-repeat"
        value={values.scheduleKind}
        disabled={disabled}
        onChange={scheduleKind => onChange({ scheduleKind })}
      />
      {values.scheduleKind === 'interval' ? (
        <Field
          id="automation-minutes"
          label={`Every N minutes (min ${SCHEDULED_JOB_MIN_INTERVAL_MINUTES})`}
          messages={errorMessages(errors.minutes)}
        >
          <Input
            size="md"
            id="automation-minutes"
            data-field="minutes"
            inputMode="numeric"
            value={values.minutes}
            aria-invalid={!!errors.minutes}
            aria-describedby={messagesId('automation-minutes', errors.minutes)}
            onChange={event => onChange({ minutes: event.target.value })}
            onBlur={() => onBlur('minutes')}
            className="w-32"
          />
        </Field>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          {values.scheduleKind === 'weekly' && (
            <Field id="automation-weekday" label="Day">
              <Select
                value={String(values.weekday)}
                onValueChange={value => onChange({ weekday: Number(value) })}
              >
                <SelectTrigger
                  id="automation-weekday"
                  size="md"
                  className="w-36"
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
            </Field>
          )}
          <Field
            id="automation-time"
            label="Time"
            messages={errorMessages(errors.time)}
          >
            <Input
              size="md"
              id="automation-time"
              data-field="time"
              type="time"
              value={values.time}
              aria-invalid={!!errors.time}
              aria-describedby={messagesId('automation-time', errors.time)}
              onChange={event => onChange({ time: event.target.value })}
              onBlur={() => onBlur('time')}
              className="w-28"
            />
          </Field>
        </div>
      )}
      <Field
        id="automation-time-zone"
        label="Time zone"
        messages={errorMessages(errors.timeZone)}
        hint={
          <>
            {preview && (
              <span role="status" className="block tabular-nums">
                {preview}
              </span>
            )}
            Missed runs are skipped, never caught up.
          </>
        }
      >
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
            aria-describedby={messagesId(
              'automation-time-zone',
              errors.timeZone,
            )}
            size="md"
            aria-invalid={!!errors.timeZone}
            className="w-full max-w-64"
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
      </Field>
    </fieldset>
  );
}
