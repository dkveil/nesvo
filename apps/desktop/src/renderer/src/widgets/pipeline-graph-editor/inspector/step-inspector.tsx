import { useId, useState } from 'react';
import {
  pipelineDefinitionLimits,
  stepTypeSchema,
  type StepPhase,
} from '@nesvo/contracts';
import { cn } from 'cn';
import { phaseLabels, phaseOrder } from '@/entities/pipeline';
import type { StepDraft } from '@/entities/pipeline-graph';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import {
  mergeNotes,
  describedBy,
  hasError,
  inspectorInput,
  inspectorTextarea,
  notesId,
  type FieldNote,
} from './field-notes';
import { Field, FieldNotes, Segmented } from './fields';
import type { StepInspectorProps } from './index';
import { NeedsField } from './needs-field';
import { SkillField } from './skill-field';
import {
  bodyLabels,
  bodyPlaceholders,
  declaresEffect,
  durationUnitLabels,
  durationUnits,
  joinDuration,
  retryOptions,
  splitDuration,
  stepFields,
  stepNotes,
  typeLabels,
  withType,
  type DurationUnit,
} from './step-form';

const scopeLabels = { global: 'Global', project: 'Project' } as const;

const usageText = (count: number) =>
  `Used by ${count} other ${count === 1 ? 'pipeline' : 'pipelines'}; the step file changes for all of them`;

function PhaseWarning({
  usedBy,
  phase,
  current,
  onConfirm,
  onCancel,
}: {
  usedBy: string[];
  phase: StepPhase;
  current: StepPhase;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-warning-foreground/40 px-2.5 py-2 text-2xs leading-4"
    >
      <p className="text-warning-foreground">{usageText(usedBy.length)}.</p>
      <p className="text-muted-foreground [overflow-wrap:anywhere]">
        {usedBy.join(', ')}
      </p>
      <div className="flex gap-1.5">
        <Button type="button" size="xs" onClick={onConfirm}>
          Move to {phaseLabels[phase]}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Keep {phaseLabels[current]}
        </Button>
      </div>
    </div>
  );
}

export function StepInspectorForm({
  step,
  mode,
  usedBy,
  skills,
  issues,
  onChange,
  onSave,
  onDelete,
}: StepInspectorProps) {
  const prefix = useId();
  const fieldId = (field: string) => `${prefix}step-${field}`;
  const baseline = mode === 'edit' ? `${step.name}:${step.hash}` : 'create';
  const [origin, setOrigin] = useState({ baseline, phase: step.phase });
  const [pendingPhase, setPendingPhase] = useState<StepPhase | null>(null);
  if (origin.baseline !== baseline) {
    setOrigin({ baseline, phase: step.phase });
    setPendingPhase(null);
  }
  const client = stepNotes(step);
  const notes = mergeNotes(client, issues, stepFields);
  const notesOf = (field: string): FieldNote[] => notes[field] ?? [];
  const blocked = Object.keys(client).length > 0;
  const update = (patch: Partial<StepDraft>) => onChange({ ...step, ...patch });
  const human = step.type === 'human';
  const shared = mode === 'edit' && usedBy.length > 0;
  const phaseMoved = shared && step.phase !== origin.phase;
  const duration = splitDuration(step.timeout);
  const units: DurationUnit[] =
    duration.unit === 'ms' ? ['ms', ...durationUnits] : [...durationUnits];
  const choosePhase = (phase: StepPhase) => {
    if (phase === step.phase) return;
    if (shared && phase !== origin.phase) setPendingPhase(phase);
    else {
      setPendingPhase(null);
      update({ phase });
    }
  };
  const formNotes = notesOf('form');
  return (
    <form
      aria-label={`Step ${step.name || 'draft'}`}
      className="flex h-full min-h-0 flex-col"
      onSubmit={event => {
        event.preventDefault();
        if (!blocked && !pendingPhase) onSave();
      }}
    >
      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-2xs">
            {scopeLabels[step.scope]}
          </Badge>
          {mode === 'create' && (
            <Badge variant="secondary" className="text-2xs">
              New step
            </Badge>
          )}
          {shared && (
            <span
              className="min-w-0 truncate text-2xs text-muted-foreground"
              title={usedBy.join(', ')}
            >
              Also in {usedBy.length}{' '}
              {usedBy.length === 1 ? 'pipeline' : 'pipelines'}
            </span>
          )}
        </div>
        <Field
          id={fieldId('name')}
          label="Name"
          notes={notesOf('name')}
          hint={mode === 'edit' ? 'The name is the file name and stays.' : null}
        >
          <Input
            id={fieldId('name')}
            value={step.name}
            readOnly={mode === 'edit'}
            autoComplete="off"
            spellCheck={false}
            maxLength={pipelineDefinitionLimits.name}
            placeholder="run-tests"
            aria-invalid={hasError(notesOf('name')) || undefined}
            aria-describedby={describedBy(fieldId('name'), notesOf('name'))}
            onChange={event => update({ name: event.target.value })}
            className={cn(
              inspectorInput,
              'font-mono',
              mode === 'edit' && 'text-muted-foreground',
            )}
          />
        </Field>
        <Field
          id={fieldId('type')}
          label="Type"
          as="span"
          notes={notesOf('type')}
        >
          <Segmented
            label="Type"
            value={step.type}
            options={stepTypeSchema.options.map(type => ({
              value: type,
              label: typeLabels[type],
            }))}
            invalid={hasError(notesOf('type'))}
            describedBy={describedBy(fieldId('type'), notesOf('type'))}
            onChange={type => onChange(withType(step, type))}
          />
        </Field>
        <Field id={fieldId('phase')} label="Phase" notes={notesOf('phase')}>
          <Select
            value={pendingPhase ?? step.phase}
            onValueChange={value => choosePhase(value as StepPhase)}
          >
            <SelectTrigger
              id={fieldId('phase')}
              size="sm"
              aria-invalid={hasError(notesOf('phase')) || undefined}
              aria-describedby={
                describedBy(fieldId('phase'), notesOf('phase')) ??
                (phaseMoved ? `${fieldId('phase')}-moved` : undefined)
              }
              className="h-7 w-full text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {phaseOrder.map(phase => (
                <SelectItem key={phase} value={phase} className="text-xs">
                  {phaseLabels[phase]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pendingPhase && (
            <PhaseWarning
              usedBy={usedBy}
              phase={pendingPhase}
              current={step.phase}
              onConfirm={() => {
                update({ phase: pendingPhase });
                setPendingPhase(null);
              }}
              onCancel={() => setPendingPhase(null)}
            />
          )}
          {phaseMoved && !pendingPhase && (
            <p
              id={`${fieldId('phase')}-moved`}
              className="text-2xs leading-4 text-warning-foreground"
            >
              Moved from {phaseLabels[origin.phase]}. {usageText(usedBy.length)}
              .
            </p>
          )}
        </Field>
        {step.type === 'agent' && (
          <Field id={fieldId('skill')} label="Skill" notes={notesOf('skill')}>
            <SkillField
              id={fieldId('skill')}
              value={step.skill}
              skills={skills}
              notes={notesOf('skill')}
              onChange={skill => update({ skill })}
            />
          </Field>
        )}
        <Field
          id={fieldId('body')}
          label={bodyLabels[step.type]}
          notes={notesOf('body')}
          aside={
            <span className="text-2xs text-muted-foreground tabular-nums">
              {step.body.length.toLocaleString()}/
              {pipelineDefinitionLimits.body.toLocaleString()}
            </span>
          }
        >
          <Textarea
            id={fieldId('body')}
            value={step.body}
            rows={6}
            spellCheck={step.type === 'agent' || human}
            maxLength={pipelineDefinitionLimits.body}
            placeholder={bodyPlaceholders[step.type]}
            aria-invalid={hasError(notesOf('body')) || undefined}
            aria-describedby={describedBy(fieldId('body'), notesOf('body'))}
            onChange={event => update({ body: event.target.value })}
            className={inspectorTextarea}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2 space-y-1" data-field={fieldId('timeout')}>
            <Label
              htmlFor={fieldId('timeout')}
              className="text-2xs text-muted-foreground"
            >
              Timeout
            </Label>
            <div className="flex gap-1.5">
              <Input
                id={fieldId('timeout')}
                inputMode="numeric"
                autoComplete="off"
                value={duration.amount}
                aria-invalid={hasError(notesOf('timeout')) || undefined}
                aria-describedby={[
                  `${fieldId('timeout')}-hint`,
                  describedBy(fieldId('timeout'), notesOf('timeout')),
                ]
                  .filter(Boolean)
                  .join(' ')}
                onChange={event =>
                  update({
                    timeout: joinDuration(event.target.value, duration.unit),
                  })
                }
                className={cn(inspectorInput, 'w-24 tabular-nums')}
              />
              <Select
                value={duration.unit}
                onValueChange={value =>
                  update({
                    timeout: joinDuration(
                      duration.amount,
                      value as DurationUnit,
                    ),
                  })
                }
              >
                <SelectTrigger
                  aria-label="Timeout unit"
                  size="sm"
                  className="h-7 flex-1 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {units.map(unit => (
                    <SelectItem key={unit} value={unit} className="text-xs">
                      {durationUnitLabels[unit]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p
              id={`${fieldId('timeout')}-hint`}
              className="text-2xs leading-4 text-muted-foreground"
            >
              Between 1 second and 4 hours.
            </p>
            <FieldNotes
              id={notesId(fieldId('timeout'))}
              notes={notesOf('timeout')}
            />
          </div>
          <Field
            id={fieldId('retries')}
            label="Retries"
            notes={notesOf('retries')}
          >
            <Select
              value={String(step.retries)}
              disabled={human}
              onValueChange={value => update({ retries: Number(value) })}
            >
              <SelectTrigger
                id={fieldId('retries')}
                size="sm"
                title={human ? 'Human steps do not retry.' : undefined}
                aria-invalid={hasError(notesOf('retries')) || undefined}
                aria-describedby={describedBy(
                  fieldId('retries'),
                  notesOf('retries'),
                )}
                className="h-7 w-full text-xs tabular-nums"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {retryOptions.map(count => (
                  <SelectItem
                    key={count}
                    value={String(count)}
                    className="text-xs tabular-nums"
                  >
                    {String(count)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            id={fieldId('on_fail')}
            label="On failure"
            as="span"
            notes={notesOf('on_fail')}
          >
            <Segmented
              label="On failure"
              value={step.on_fail}
              disabled={human}
              options={[
                {
                  value: 'stop',
                  label: 'Stop',
                  title: 'The run fails when this step fails.',
                },
                {
                  value: 'fix',
                  label: 'Fix',
                  title: 'The failure goes back to the author for a fix.',
                },
              ]}
              describedBy={describedBy(fieldId('on_fail'), notesOf('on_fail'))}
              onChange={on_fail => update({ on_fail })}
            />
          </Field>
          {human && (
            <p className="col-span-2 text-2xs leading-4 text-muted-foreground">
              Human steps do not retry; the reviewer accepts, rejects or asks
              for a fix.
            </p>
          )}
        </div>
        <NeedsField
          id={fieldId('needs')}
          needs={step.needs}
          notes={notesOf('needs')}
          onChange={needs => update({ needs })}
        />
        <div className="space-y-1" data-field={fieldId('effect')}>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={fieldId('effect')} className="text-xs font-normal">
              External effect
            </Label>
            <Switch
              id={fieldId('effect')}
              checked={step.effect === 'external'}
              disabled={!declaresEffect(step.type)}
              aria-invalid={hasError(notesOf('effect')) || undefined}
              aria-describedby={describedBy(
                fieldId('effect'),
                notesOf('effect'),
              )}
              onCheckedChange={checked =>
                update({ effect: checked ? 'external' : 'local' })
              }
            />
          </div>
          <p className="text-2xs leading-4 text-muted-foreground">
            {declaresEffect(step.type)
              ? 'Reaches beyond this computer, such as a deploy or a message. Put a human step before it.'
              : 'Only command and action steps declare an external effect.'}
          </p>
          <FieldNotes
            id={notesId(fieldId('effect'))}
            notes={notesOf('effect')}
          />
        </div>
        {formNotes.length > 0 && (
          <div role="alert">
            <FieldNotes id={fieldId('form-notes')} notes={formNotes} />
          </div>
        )}
      </div>
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-t px-3">
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onDelete}
            className="text-muted-foreground"
          >
            {mode === 'create' ? 'Discard step' : 'Remove from pipeline'}
          </Button>
        )}
        <span className="min-w-0 flex-1" />
        <Button
          type="submit"
          size="xs"
          disabled={blocked || !!pendingPhase}
          title={
            blocked
              ? 'Fix the marked fields to save.'
              : pendingPhase
                ? 'Confirm or keep the phase first.'
                : undefined
          }
        >
          {mode === 'create' ? 'Create step' : 'Save step'}
        </Button>
      </div>
    </form>
  );
}
