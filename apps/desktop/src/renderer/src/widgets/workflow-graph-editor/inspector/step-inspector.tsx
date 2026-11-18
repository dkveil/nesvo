import { useId, useState } from 'react';
import {
  workflowDefinitionLimits,
  stepTypeSchema,
  type StepPhase,
} from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { phaseLabels, phaseOrder } from '@/entities/workflow';
import type { StepDraft } from '@/entities/workflow-graph';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
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
  type FieldNote,
} from './field-notes';
import { DisabledHint } from '@/shared/ui/disabled-hint';
import { Field, FieldMessages } from '@/shared/ui/field';
import { Toolbar, ToolbarSpacer } from '@/shared/ui/panel';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { Hint } from '@/shared/ui/tooltip';
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
  `Used by ${count} other ${count === 1 ? 'workflow' : 'workflows'}; the step file changes for all of them`;

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
      className="space-y-2 rounded-control border border-warning-foreground/40 px-2.5 py-2 text-2xs leading-4"
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
  renamable = false,
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
  const canRetry = !human && step.type !== 'until';
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
          <Badge appearance="outline">{scopeLabels[step.scope]}</Badge>
          {mode === 'create' && <Badge>New step</Badge>}
          {shared && (
            <Hint label={usedBy.join(', ')}>
              <span className="min-w-0 truncate text-2xs text-muted-foreground">
                Also in {usedBy.length}{' '}
                {usedBy.length === 1 ? 'workflow' : 'workflows'}
              </span>
            </Hint>
          )}
        </div>
        <Field
          id={fieldId('name')}
          label="Name"
          messages={notesOf('name')}
          hint={
            mode === 'edit' && !renamable
              ? 'The name is the file name and stays.'
              : null
          }
        >
          <Input
            size="sm"
            id={fieldId('name')}
            value={step.name}
            readOnly={mode === 'edit' && !renamable}
            autoComplete="off"
            spellCheck={false}
            maxLength={workflowDefinitionLimits.name}
            placeholder="run-tests"
            aria-invalid={hasError(notesOf('name')) || undefined}
            aria-describedby={describedBy(fieldId('name'), notesOf('name'))}
            onChange={event => update({ name: event.target.value })}
            className={cn(
              'font-mono',
              mode === 'edit' && !renamable && 'text-muted-foreground',
            )}
          />
        </Field>
        <Field
          id={fieldId('type')}
          label="Type"
          as="span"
          messages={notesOf('type')}
        >
          <SegmentedControl
            fullWidth
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
        <Field id={fieldId('phase')} label="Phase" messages={notesOf('phase')}>
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
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {phaseOrder.map(phase => (
                <SelectItem key={phase} value={phase}>
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
          <Field
            id={fieldId('skill')}
            label="Skill"
            messages={notesOf('skill')}
          >
            <SkillField
              id={fieldId('skill')}
              value={step.skill}
              skills={skills}
              notes={notesOf('skill')}
              onChange={skill => update({ skill })}
            />
          </Field>
        )}
        {step.type === 'until' && (
          <>
            <Field
              id={fieldId('repeat')}
              label="Repeat steps"
              hint="Enter step names in execution order, separated by commas."
              messages={notesOf('repeat')}
            >
              <Input
                size="sm"
                id={fieldId('repeat')}
                value={step.repeat?.join(',') ?? ''}
                onChange={event =>
                  update({ repeat: event.target.value.split(',') })
                }
              />
            </Field>
            <Field
              id={fieldId('condition')}
              label="Stop condition"
              hint={'Use steps.<step>.outputs.<key> == "value" or != "value".'}
              messages={notesOf('condition')}
            >
              <Input
                size="sm"
                id={fieldId('condition')}
                value={step.condition ?? ''}
                onChange={event => update({ condition: event.target.value })}
              />
            </Field>
            <Field
              id={fieldId('max_iterations')}
              label="Maximum iterations"
              hint="From 1 to 20."
              messages={notesOf('max_iterations')}
            >
              <Input
                size="sm"
                type="number"
                min={1}
                max={20}
                id={fieldId('max_iterations')}
                value={step.max_iterations ?? ''}
                onChange={event =>
                  update({
                    max_iterations: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  })
                }
              />
            </Field>
          </>
        )}
        {step.type === 'wait-ci' && (
          <>
            <Field
              id={fieldId('pr')}
              label="Pull request"
              hint="Leave empty to use the session link. Accepts a URL, number or steps.<step>.outputs.<key>."
              messages={notesOf('pr')}
            >
              <Input
                size="sm"
                id={fieldId('pr')}
                value={step.pr ?? ''}
                onChange={event =>
                  update({ pr: event.target.value || undefined })
                }
              />
            </Field>
            <Field
              id={fieldId('poll_interval')}
              label="Poll interval"
              hint="From 1s to 1m. Defaults to 10s."
              messages={notesOf('poll_interval')}
            >
              <Input
                size="sm"
                id={fieldId('poll_interval')}
                value={step.poll_interval ?? ''}
                onChange={event =>
                  update({ poll_interval: event.target.value || undefined })
                }
              />
            </Field>
          </>
        )}
        <Field
          id={fieldId('body')}
          label={bodyLabels[step.type]}
          messages={notesOf('body')}
          aside={
            <span className="text-2xs text-muted-foreground tabular-nums">
              {step.body.length.toLocaleString()}/
              {workflowDefinitionLimits.body.toLocaleString()}
            </span>
          }
        >
          <Textarea
            size="sm"
            id={fieldId('body')}
            value={step.body}
            rows={6}
            spellCheck={step.type === 'agent' || human}
            maxLength={workflowDefinitionLimits.body}
            placeholder={bodyPlaceholders[step.type]}
            aria-invalid={hasError(notesOf('body')) || undefined}
            aria-describedby={describedBy(fieldId('body'), notesOf('body'))}
            onChange={event => update({ body: event.target.value })}
            className="max-h-72 min-h-24 font-mono text-xs leading-5"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field
            id={fieldId('timeout')}
            label="Timeout"
            hint="Between 1 second and 4 hours."
            messages={notesOf('timeout')}
            className="col-span-2"
          >
            <div className="flex gap-1.5">
              <Input
                size="sm"
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
                className="w-24 tabular-nums"
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
                  className="flex-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {units.map(unit => (
                    <SelectItem key={unit} value={unit}>
                      {durationUnitLabels[unit]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>
          <Field
            id={fieldId('retries')}
            label="Retries"
            messages={notesOf('retries')}
          >
            <Select
              value={String(step.retries)}
              disabled={!canRetry}
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
                className="w-full tabular-nums"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {retryOptions.map(count => (
                  <SelectItem
                    key={count}
                    value={String(count)}
                    className="tabular-nums"
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
            messages={notesOf('on_fail')}
          >
            <SegmentedControl
              fullWidth
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
          {canRetry && step.retries > 0 && (
            <>
              <Field
                id={fieldId('retry_backoff')}
                label="Retry backoff"
                hint="Optional delay between attempts, such as 10s."
                messages={notesOf('retry_backoff')}
              >
                <Input
                  size="sm"
                  id={fieldId('retry_backoff')}
                  value={step.retry_backoff ?? ''}
                  onChange={event =>
                    update({
                      retry_backoff: event.target.value.trim() || undefined,
                    })
                  }
                />
              </Field>
              <Field
                id={fieldId('idempotent')}
                label="Safe to repeat"
                hint="Enable only if repeating the step cannot duplicate its effects."
                messages={notesOf('idempotent')}
              >
                <Switch
                  id={fieldId('idempotent')}
                  checked={step.idempotent ?? false}
                  onCheckedChange={idempotent => update({ idempotent })}
                />
              </Field>
            </>
          )}
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
        <Field
          id={fieldId('effect')}
          label="External effect"
          layout="switch"
          hint={
            declaresEffect(step.type)
              ? 'Reaches beyond this computer, such as a deploy or a message. Put a human step before it.'
              : 'Only command and action steps declare an external effect.'
          }
          messages={notesOf('effect')}
        >
          <Switch
            id={fieldId('effect')}
            checked={step.effect === 'external'}
            disabled={!declaresEffect(step.type)}
            aria-invalid={hasError(notesOf('effect')) || undefined}
            aria-describedby={[
              `${fieldId('effect')}-hint`,
              describedBy(fieldId('effect'), notesOf('effect')),
            ]
              .filter(Boolean)
              .join(' ')}
            onCheckedChange={checked =>
              update({ effect: checked ? 'external' : 'local' })
            }
          />
        </Field>
        {formNotes.length > 0 && (
          <div role="alert">
            <FieldMessages id={fieldId('form-notes')} messages={formNotes} />
          </div>
        )}
      </div>
      <Toolbar
        label="Step actions"
        bordered={false}
        className="h-10 border-t px-3"
      >
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onDelete}
            className="text-muted-foreground"
          >
            {mode === 'create' ? 'Discard step' : 'Remove from workflow'}
          </Button>
        )}
        <ToolbarSpacer />
        <DisabledHint
          reason={
            blocked
              ? 'Fix the marked fields to save.'
              : pendingPhase
                ? 'Confirm or keep the phase first.'
                : ''
          }
        >
          <Button type="submit" size="xs" disabled={blocked || !!pendingPhase}>
            {mode === 'create' ? 'Create step' : 'Save step'}
          </Button>
        </DisabledHint>
      </Toolbar>
    </form>
  );
}
