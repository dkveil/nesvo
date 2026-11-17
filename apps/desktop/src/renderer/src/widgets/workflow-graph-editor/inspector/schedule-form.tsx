import { useId, useState } from 'react';
import {
  workflowDefinitionLimits,
  SCHEDULED_JOB_MAX_INTERVAL_MINUTES,
  scheduledJobLimits,
  type TaskSpecSummary,
} from '@nesvo/contracts';
import { errorDetail, type ProviderStates } from '@/entities/session';
import { RepeatField } from '@/features/edit-automation';
import { ModelPicker } from '@/features/new-thread/model-picker';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import {
  automationInput,
  automationNotes,
  initialScheduleValues,
  listTimeZones,
  weekdayLabels,
  weekdayOrder,
  type ScheduleValues,
} from './automation-form';
import { Field, FieldMessages } from '@/shared/ui/field';
import { describedBy, hasError, type FieldNote } from './field-notes';
import type { AutomationInput } from './index';

type Props = {
  directory: string;
  workflowName: string;
  specs: TaskSpecSummary[];
  statuses: ProviderStates;
  disabled: boolean;
  onSave: (input: AutomationInput) => Promise<void>;
  onRefreshProvider: () => void;
  onCancel: () => void;
};

const OTHER_SPEC = '__other__';

export function ScheduleForm({
  directory,
  workflowName,
  specs,
  statuses,
  disabled,
  onSave,
  onRefreshProvider,
  onCancel,
}: Props) {
  const prefix = useId();
  const fieldId = (field: string) => `${prefix}schedule-${field}`;
  const ownSpecs = specs.filter(spec => spec.workflow === workflowName);
  const [id] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<ScheduleValues>(() =>
    initialScheduleValues(
      workflowName,
      ownSpecs[0]?.source.path ?? '',
      'Claude Code',
      statuses['Claude Code'].status?.models[0]?.id ?? '',
    ),
  );
  const [customSpec, setCustomSpec] = useState(ownSpecs.length === 0);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const model =
    values.model || (statuses[values.provider].status?.models[0]?.id ?? '');
  const effective = { ...values, model };
  const input = automationInput(effective, id, directory, workflowName);
  const notes = automationNotes(effective, input);
  const notesOf = (field: string): FieldNote[] =>
    attempted ? (notes[field] ?? []) : [];
  const invalid = Object.keys(notes).length > 0;
  const change = (patch: Partial<ScheduleValues>) => {
    setValues(current => ({ ...current, ...patch }));
    setFailure('');
  };
  const submit = async () => {
    setAttempted(true);
    if (invalid || saving) return;
    setSaving(true);
    setFailure('');
    try {
      await onSave(input);
    } catch (error) {
      setFailure(errorDetail(error));
    } finally {
      setSaving(false);
    }
  };
  const zones = listTimeZones(values.timeZone);
  const locked = disabled || saving;
  const formNotes = [
    ...notesOf('form'),
    ...notesOf('prompt'),
    ...notesOf('directory'),
    ...notesOf('effort'),
    ...notesOf('kind'),
  ];
  return (
    <form
      aria-label="Add schedule"
      className="space-y-3 rounded-surface border bg-card p-2.5"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={locked} className="space-y-3">
        <Field id={fieldId('name')} label="Name" messages={notesOf('name')}>
          <Input
            size="sm"
            id={fieldId('name')}
            value={values.name}
            maxLength={scheduledJobLimits.name}
            autoComplete="off"
            aria-invalid={hasError(notesOf('name')) || undefined}
            aria-describedby={describedBy(fieldId('name'), notesOf('name'))}
            onChange={event => change({ name: event.target.value })}
          />
        </Field>
        <Field
          id={fieldId('specPath')}
          label="Task spec"
          messages={notesOf('specPath')}
        >
          {ownSpecs.length > 0 && (
            <Select
              value={customSpec ? OTHER_SPEC : values.specPath}
              onValueChange={value => {
                const other = value === OTHER_SPEC;
                setCustomSpec(other);
                change({ specPath: other ? '' : value });
              }}
            >
              <SelectTrigger
                id={customSpec ? undefined : fieldId('specPath')}
                aria-label={customSpec ? 'Task spec source' : undefined}
                size="sm"
                aria-invalid={
                  (!customSpec && hasError(notesOf('specPath'))) || undefined
                }
                aria-describedby={
                  customSpec
                    ? undefined
                    : describedBy(fieldId('specPath'), notesOf('specPath'))
                }
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {ownSpecs.map(spec => (
                  <SelectItem key={spec.source.path} value={spec.source.path}>
                    {spec.title ?? spec.source.path.split(/[\\/]/).at(-1)}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER_SPEC}>Another path</SelectItem>
              </SelectContent>
            </Select>
          )}
          {customSpec && (
            <Input
              size="sm"
              id={fieldId('specPath')}
              value={values.specPath}
              placeholder="Absolute path to a task spec file"
              maxLength={workflowDefinitionLimits.path}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={hasError(notesOf('specPath')) || undefined}
              aria-describedby={describedBy(
                fieldId('specPath'),
                notesOf('specPath'),
              )}
              onChange={event => change({ specPath: event.target.value })}
              className="font-mono"
            />
          )}
        </Field>
        <RepeatField
          id={fieldId('repeat')}
          value={values.kind}
          disabled={locked}
          onChange={kind => change({ kind })}
        />
        <div className="flex flex-wrap items-start gap-2">
          {values.kind === 'interval' ? (
            <Field
              id={fieldId('minutes')}
              label="Every N minutes"
              messages={notesOf('minutes')}
            >
              <Input
                size="sm"
                id={fieldId('minutes')}
                inputMode="numeric"
                value={values.minutes}
                maxLength={String(SCHEDULED_JOB_MAX_INTERVAL_MINUTES).length}
                aria-invalid={hasError(notesOf('minutes')) || undefined}
                aria-describedby={describedBy(
                  fieldId('minutes'),
                  notesOf('minutes'),
                )}
                onChange={event => change({ minutes: event.target.value })}
                className="w-24 tabular-nums"
              />
            </Field>
          ) : (
            <>
              {values.kind === 'weekly' && (
                <Field id={fieldId('weekday')} label="Day">
                  <Select
                    value={String(values.weekday)}
                    onValueChange={value => change({ weekday: Number(value) })}
                  >
                    <SelectTrigger
                      id={fieldId('weekday')}
                      size="sm"
                      className="w-32"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {weekdayOrder.map(day => (
                        <SelectItem key={day} value={String(day)}>
                          {weekdayLabels[day]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field
                id={fieldId('time')}
                label="Time"
                messages={notesOf('time')}
              >
                <Input
                  size="sm"
                  id={fieldId('time')}
                  type="time"
                  value={values.time}
                  aria-invalid={hasError(notesOf('time')) || undefined}
                  aria-describedby={describedBy(
                    fieldId('time'),
                    notesOf('time'),
                  )}
                  onChange={event => change({ time: event.target.value })}
                  className="w-28 tabular-nums"
                />
              </Field>
            </>
          )}
        </div>
        <Field
          id={fieldId('timeZone')}
          label="Time zone"
          messages={notesOf('timeZone')}
        >
          <Select
            value={values.timeZone}
            onValueChange={timeZone => change({ timeZone })}
          >
            <SelectTrigger
              id={fieldId('timeZone')}
              size="sm"
              aria-invalid={hasError(notesOf('timeZone')) || undefined}
              aria-describedby={describedBy(
                fieldId('timeZone'),
                notesOf('timeZone'),
              )}
              className="w-full"
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
        <Field
          id={fieldId('model')}
          label="Provider and model"
          as="span"
          messages={notesOf('model')}
        >
          <div
            role="group"
            aria-labelledby={`${fieldId('model')}-label`}
            aria-describedby={describedBy(fieldId('model'), notesOf('model'))}
            className="flex h-7 items-center rounded-control border border-input px-0.5 shadow-xs dark:bg-input/30"
          >
            <ModelPicker
              provider={values.provider}
              model={model}
              effort={values.effort}
              statuses={statuses}
              disabled={locked}
              onChange={(provider, model, effort) =>
                change({ provider, model, effort })
              }
              onRefreshProvider={onRefreshProvider}
            />
          </div>
        </Field>
        <Field
          id={fieldId('timeoutMinutes')}
          label="Timeout in minutes"
          messages={notesOf('timeoutMinutes')}
        >
          <Input
            size="sm"
            id={fieldId('timeoutMinutes')}
            inputMode="numeric"
            value={values.timeoutMinutes}
            maxLength={3}
            aria-invalid={hasError(notesOf('timeoutMinutes')) || undefined}
            aria-describedby={describedBy(
              fieldId('timeoutMinutes'),
              notesOf('timeoutMinutes'),
            )}
            onChange={event => change({ timeoutMinutes: event.target.value })}
            className="w-24 tabular-nums"
          />
        </Field>
      </fieldset>
      <p className="text-2xs leading-4 text-muted-foreground">
        Runs read-only from the task spec. Missed runs are skipped, never caught
        up.
      </p>
      {formNotes.length > 0 && (
        <div role="alert">
          <FieldMessages id={fieldId('form-notes')} messages={formNotes} />
        </div>
      )}
      {failure && <StatusMessage tone="error">{failure}</StatusMessage>}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={locked}>
          {saving ? 'Saving…' : 'Add schedule'}
        </Button>
      </div>
    </form>
  );
}
