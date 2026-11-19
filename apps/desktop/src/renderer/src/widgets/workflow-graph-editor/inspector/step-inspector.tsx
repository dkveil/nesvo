import { useId, useState } from 'react';
import {
  workflowDefinitionLimits,
  stepTypeSchema,
  probeKindSchema,
  checkIntentSchema,
  providerSchema,
  isChildWorkflowStep,
  type StepPhase,
} from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { phaseLabels, phaseOrder } from '@/entities/workflow';
import type { StepDraft } from '@/entities/workflow-graph';
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
import { SavedInField } from '@/shared/ui/saved-in-field';
import { PanelBody, ToolbarSpacer } from '@/shared/ui/panel';
import { SidePanelFooter } from '@/shared/ui/side-panel';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import type { StepInspectorProps } from './index';
import { NeedsField } from './needs-field';
import { PromptTextarea } from '@/features/select-skill/prompt-textarea';
import { pendingSkillQuery } from '@/features/select-skill/skill-command';
import type { Provider } from '@/entities/session';
import { ChildFields } from './child-fields';
import {
  allowsRetries,
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

const inlineFieldClass =
  'grid-cols-[7rem_minmax(0,1fr)] [&_label]:text-ui [&_label]:leading-5';

export function StepInspectorForm({
  step,
  mode,
  renamable = false,
  beforeFields,
  usedBy,
  hostId,
  directory,
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
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const creating = mode === 'create';
  const [catalogProvider, setCatalogProvider] = useState<Provider | null>(null);
  const prompts = step.type === 'agent' || isChildWorkflowStep(step.type);
  const provider =
    step.session?.provider ??
    catalogProvider ??
    (step.prompt_skill?.delivery === 'instructions' ||
    step.needs.includes('browser')
      ? 'Claude Code'
      : 'Codex');
  const childFolder = step.session?.directory;
  const promptFolder =
    !childFolder || childFolder === '.'
      ? directory
      : /^(?:[A-Za-z]:[\\/]|[\\/])/.test(childFolder)
        ? childFolder
        : directory
          ? `${directory}/${childFolder}`
          : '';
  const skillQueryOpen = prompts && pendingSkillQuery(step.body);
  const client = stepNotes(step);
  if (skillQueryOpen)
    client.body = [
      {
        severity: 'error',
        message: 'Choose a skill from the list or remove the slash query.',
      },
    ];
  const notes = mergeNotes(client, issues, stepFields);
  const notesOf = (field: string, touchField = field): FieldNote[] =>
    !creating || submitted || touched.has(touchField)
      ? (notes[field] ?? [])
      : [];
  const blocked = Object.keys(client).length > 0;
  const update = (patch: Partial<StepDraft>) => onChange({ ...step, ...patch });
  const human = step.type === 'human';
  const canRetry = allowsRetries(step.type);
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
  const bodyNotes = [...notesOf('body'), ...notesOf('prompt_skill', 'body')];
  const bodyProps = {
    size: 'sm' as const,
    id: fieldId('body'),
    value: step.body,
    rows: 6,
    resize: 'none' as const,
    spellCheck: step.type === 'agent' || human,
    maxLength: workflowDefinitionLimits.body,
    placeholder: bodyPlaceholders[step.type],
    'aria-invalid': hasError(bodyNotes) || undefined,
    'aria-describedby': describedBy(fieldId('body'), bodyNotes),
    className: cn(
      'max-h-72 min-h-24 font-mono text-xs leading-5',
      step.type === 'check' && 'resize-none',
    ),
  };
  return (
    <form
      aria-label={`Step ${step.name || 'draft'}`}
      className="flex h-full min-h-0 flex-col"
      onBlur={event => {
        if (!creating) return;
        const id =
          event.target.closest<HTMLElement>('[data-field]')?.dataset.field;
        if (!id?.startsWith(fieldId(''))) return;
        const field = id.slice(fieldId('').length);
        setTouched(previous =>
          previous.has(field) ? previous : new Set([...previous, field]),
        );
      }}
      onSubmit={event => {
        event.preventDefault();
        setSubmitted(true);
        if (!blocked && !pendingPhase) onSave();
      }}
    >
      <PanelBody className="space-y-3 overscroll-contain p-3">
        {beforeFields && <div className="-mx-3 -mt-3">{beforeFields}</div>}
        <SavedInField
          id={fieldId('scope')}
          scope={step.scope}
          layout="inline"
          className={inlineFieldClass}
          onChange={creating ? scope => update({ scope }) : undefined}
        />
        {shared && (
          <p className="text-2xs leading-4 text-muted-foreground">
            {usageText(usedBy.length)}.
          </p>
        )}
        <Field
          id={fieldId('name')}
          label="Name"
          layout="inline"
          className={inlineFieldClass}
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
          layout="inline"
          className={inlineFieldClass}
          label="Type"
          messages={notesOf('type')}
        >
          <Select
            value={step.type}
            onValueChange={type =>
              onChange(withType(step, stepTypeSchema.parse(type)))
            }
          >
            <SelectTrigger
              id={fieldId('type')}
              size="sm"
              className="w-full"
              aria-invalid={hasError(notesOf('type')) || undefined}
              aria-describedby={describedBy(fieldId('type'), notesOf('type'))}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {stepTypeSchema.options.map(type => (
                <SelectItem key={type} value={type}>
                  {typeLabels[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id={fieldId('phase')}
          layout="inline"
          className={inlineFieldClass}
          label="Phase"
          messages={notesOf('phase')}
        >
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
        {step.type === 'agent' && step.skill && (
          <Field
            id={fieldId('skill')}
            label="Saved skill name"
            messages={notesOf('skill')}
          >
            <Input
              id={fieldId('skill')}
              value={step.skill}
              onChange={event => update({ skill: event.target.value || null })}
            />
          </Field>
        )}
        {step.type === 'check' && (
          <>
            <Field
              id={fieldId('intent')}
              label="Intent"
              messages={notesOf('intent')}
            >
              <Select
                value={step.intent ?? 'tests'}
                onValueChange={value =>
                  update({ intent: checkIntentSchema.parse(value) })
                }
              >
                <SelectTrigger id={fieldId('intent')} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="tests">Tests</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              id={fieldId('preferred') + '-typescript'}
              label="TypeScript script"
              messages={notesOf('preferred')}
            >
              <Input
                id={fieldId('preferred') + '-typescript'}
                size="sm"
                value={step.preferred?.typescript?.script ?? ''}
                placeholder="test"
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                onChange={event => {
                  const script = event.target.value;
                  update({
                    preferred: {
                      ...step.preferred,
                      typescript: script
                        ? { runner: 'package-script', script }
                        : undefined,
                    },
                  });
                }}
              />
            </Field>
            <Field
              id={fieldId('preferred') + '-kotlin'}
              label="Kotlin Gradle task"
            >
              <Input
                id={fieldId('preferred') + '-kotlin'}
                size="sm"
                value={step.preferred?.kotlin?.task ?? ''}
                placeholder="test"
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                onChange={event => {
                  const task = event.target.value;
                  update({
                    preferred: {
                      ...step.preferred,
                      kotlin: task
                        ? { runner: 'gradle-wrapper', task }
                        : undefined,
                    },
                  });
                }}
              />
            </Field>
          </>
        )}
        {step.type === 'probe' && (
          <Field
            id={fieldId('probe')}
            label="Checks"
            messages={notesOf('probe')}
          >
            <Select
              value={step.probe ?? 'all'}
              onValueChange={value =>
                update({ probe: probeKindSchema.parse(value) })
              }
            >
              <SelectTrigger id={fieldId('probe')} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="all">All checks</SelectItem>
                <SelectItem value="secrets">Secrets</SelectItem>
                <SelectItem value="personal-data">Personal data</SelectItem>
                <SelectItem value="test-integrity">Test integrity</SelectItem>
                <SelectItem value="change-size">Change size</SelectItem>
              </SelectContent>
            </Select>
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
        {step.session && (
          <ChildFields
            step={step}
            fieldId={fieldId}
            notesOf={notesOf}
            update={update}
          />
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
        {step.type === 'agent' && (
          <Field
            id={fieldId('skill-provider')}
            layout="inline"
            className={inlineFieldClass}
            label="Skill provider"
          >
            <Select
              value={provider}
              onValueChange={value =>
                setCatalogProvider(providerSchema.parse(value))
              }
            >
              <SelectTrigger id={fieldId('skill-provider')} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerSchema.options.map(option => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field
          id={fieldId('body')}
          label={bodyLabels[step.type]}
          messages={bodyNotes}
          aside={
            step.body.length >= workflowDefinitionLimits.body * 0.9 && (
              <span className="text-2xs text-muted-foreground tabular-nums">
                {step.body.length.toLocaleString()}/
                {workflowDefinitionLimits.body.toLocaleString()}
              </span>
            )
          }
        >
          {prompts ? (
            <PromptTextarea
              {...bodyProps}
              skill={step.prompt_skill}
              scope={{
                hostId,
                provider,
                input: { provider, directory: promptFolder },
              }}
              onChange={(body, prompt_skill) =>
                update({
                  body,
                  prompt_skill,
                  ...(prompt_skill ? { skill: null } : {}),
                })
              }
            />
          ) : (
            <Textarea
              {...bodyProps}
              onChange={event => update({ body: event.target.value })}
            />
          )}
        </Field>
        <div className="space-y-2">
          <Field
            id={fieldId('timeout')}
            label="Timeout"
            hint="Between 1 second and 4 hours."
            messages={notesOf('timeout')}
            layout="inline"
            className={inlineFieldClass}
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
                className="w-16 flex-none tabular-nums"
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
                  className="min-w-0 flex-1"
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
            layout="inline"
            className={inlineFieldClass}
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
            layout="inline"
            className={cn(inlineFieldClass, '[&>div:first-child>span]:text-ui')}
            as="span"
            messages={notesOf('on_fail')}
          >
            <SegmentedControl
              fullWidth
              className="[&_[role=radio]]:text-ui [&_[role=radio]]:leading-5"
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
            <p className="text-2xs leading-4 text-muted-foreground">
              Human steps do not retry; the reviewer accepts, rejects or asks
              for a fix.
            </p>
          )}
        </div>
        <NeedsField
          id={fieldId('needs')}
          fieldClassName={inlineFieldClass}
          needs={step.needs}
          notes={notesOf('needs')}
          onChange={needs => update({ needs })}
        />
        <Field
          id={fieldId('effect')}
          label="External effect"
          layout="switch"
          className={cn(inlineFieldClass, '[&>div:nth-child(2)]:justify-start')}
          hint={
            declaresEffect(step.type)
              ? 'Add a human step before deploying or posting.'
              : 'Available for commands and actions.'
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
      </PanelBody>
      <SidePanelFooter label="Step actions">
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
            blocked && !creating
              ? 'Fix the marked fields to save.'
              : pendingPhase
                ? 'Confirm or keep the phase first.'
                : ''
          }
        >
          <Button
            type="submit"
            size="xs"
            disabled={(!creating && blocked) || !!pendingPhase}
          >
            {mode === 'create' ? 'Create step' : 'Save step'}
          </Button>
        </DisabledHint>
      </SidePanelFooter>
    </form>
  );
}
