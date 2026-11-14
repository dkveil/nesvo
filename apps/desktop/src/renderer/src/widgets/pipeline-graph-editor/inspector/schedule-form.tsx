import { useState } from 'react';
import {
  pipelineDefinitionLimits,
  scheduledJobLimits,
  type TaskSpecSummary,
} from '@nesvo/contracts';
import { cn } from 'cn';
import { errorDetail, type ProviderStates } from '@/entities/session';
import { ModelPicker } from '@/features/new-thread/model-picker';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
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
  scheduleKindLabels,
  scheduleKinds,
  weekdayLabels,
  weekdayOrder,
  type ScheduleValues,
} from './automation-form';
import { Field, FieldNotes, Segmented } from './fields';
import {
  describedBy,
  hasError,
  inspectorInput,
  type FieldNote,
} from './field-notes';
import type { AutomationInput } from './index';

type Props = {
  directory: string;
  pipelineName: string;
  specs: TaskSpecSummary[];
  statuses: ProviderStates;
  disabled: boolean;
  onSave: (input: AutomationInput) => Promise<void>;
  onRefreshProvider: () => void;
  onCancel: () => void;
};

const OTHER_SPEC = '__other__';

const fieldId = (field: string) => `start-inspector-${field}`;

export function ScheduleForm({
  directory,
  pipelineName,
  specs,
  statuses,
  disabled,
  onSave,
  onRefreshProvider,
  onCancel,
}: Props) {
  const ownSpecs = specs.filter(spec => spec.pipeline === pipelineName);
  const [id] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<ScheduleValues>(() =>
    initialScheduleValues(
      pipelineName,
      ownSpecs[0]?.source.path ?? '',
      'Claude Code',
      statuses['Claude Code'].status?.models[0]?.id ?? '',
    ),
  );
  const [customSpec, setCustomSpec] = useState(ownSpecs.length === 0);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const input = automationInput(values, id, directory, pipelineName);
  const notes = automationNotes(values, input);
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
      className="space-y-3 rounded-lg border bg-card p-2.5"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={locked} className="space-y-3">
        <Field id={fieldId('name')} label="Name" notes={notesOf('name')}>
          <Input
            id={fieldId('name')}
            value={values.name}
            maxLength={scheduledJobLimits.name}
            autoComplete="off"
            aria-invalid={hasError(notesOf('name')) || undefined}
            aria-describedby={describedBy(fieldId('name'), notesOf('name'))}
            onChange={event => change({ name: event.target.value })}
            className={inspectorInput}
          />
        </Field>
        <Field
          id={fieldId('specPath')}
          label="Task spec"
          notes={notesOf('specPath')}
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
                className="h-7 w-full text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {ownSpecs.map(spec => (
                  <SelectItem
                    key={spec.source.path}
                    value={spec.source.path}
                    className="text-xs"
                  >
                    {spec.title ?? spec.source.path.split(/[\\/]/).at(-1)}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER_SPEC} className="text-xs">
                  Another path
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          {customSpec && (
            <Input
              id={fieldId('specPath')}
              value={values.specPath}
              placeholder="Absolute path to a task spec file"
              maxLength={pipelineDefinitionLimits.path}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={hasError(notesOf('specPath')) || undefined}
              aria-describedby={describedBy(
                fieldId('specPath'),
                notesOf('specPath'),
              )}
              onChange={event => change({ specPath: event.target.value })}
              className={cn(inspectorInput, 'font-mono')}
            />
          )}
        </Field>
        <Field id={fieldId('repeat')} label="Repeat" as="span">
          <Segmented
            label="Repeat"
            value={values.kind}
            disabled={locked}
            options={scheduleKinds.map(kind => ({
              value: kind,
              label: scheduleKindLabels[kind],
            }))}
            onChange={kind => change({ kind })}
          />
        </Field>
        <div className="flex flex-wrap items-start gap-2">
          {values.kind === 'interval' ? (
            <Field
              id={fieldId('minutes')}
              label="Every N minutes"
              notes={notesOf('minutes')}
            >
              <Input
                id={fieldId('minutes')}
                inputMode="numeric"
                value={values.minutes}
                maxLength={5}
                aria-invalid={hasError(notesOf('minutes')) || undefined}
                aria-describedby={describedBy(
                  fieldId('minutes'),
                  notesOf('minutes'),
                )}
                onChange={event => change({ minutes: event.target.value })}
                className={cn(inspectorInput, 'w-24 tabular-nums')}
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
                      className="h-7 w-32 text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {weekdayOrder.map(day => (
                        <SelectItem
                          key={day}
                          value={String(day)}
                          className="text-xs"
                        >
                          {weekdayLabels[day]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field id={fieldId('time')} label="Time" notes={notesOf('time')}>
                <Input
                  id={fieldId('time')}
                  type="time"
                  value={values.time}
                  aria-invalid={hasError(notesOf('time')) || undefined}
                  aria-describedby={describedBy(
                    fieldId('time'),
                    notesOf('time'),
                  )}
                  onChange={event => change({ time: event.target.value })}
                  className={cn(inspectorInput, 'w-28 tabular-nums')}
                />
              </Field>
            </>
          )}
        </div>
        <Field
          id={fieldId('timeZone')}
          label="Time zone"
          notes={notesOf('timeZone')}
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
              className="h-7 w-full text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-72">
              {zones.map(zone => (
                <SelectItem key={zone} value={zone} className="text-xs">
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
          notes={notesOf('model')}
        >
          <div
            aria-labelledby={`${fieldId('model')}-label`}
            aria-describedby={describedBy(fieldId('model'), notesOf('model'))}
            className="flex h-8 items-center rounded-md border border-input px-0.5 dark:bg-input/30"
          >
            <ModelPicker
              provider={values.provider}
              model={values.model}
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
          notes={notesOf('timeoutMinutes')}
        >
          <Input
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
            className={cn(inspectorInput, 'w-24 tabular-nums')}
          />
        </Field>
      </fieldset>
      <p className="text-2xs leading-4 text-muted-foreground">
        Runs read-only from the task spec. Missed runs are skipped, never caught
        up.
      </p>
      {formNotes.length > 0 && (
        <div role="alert">
          <FieldNotes id={fieldId('form-notes')} notes={formNotes} />
        </div>
      )}
      {failure && (
        <p
          role="alert"
          className="text-2xs leading-4 text-error-foreground [overflow-wrap:anywhere]"
        >
          {failure}
        </p>
      )}
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
