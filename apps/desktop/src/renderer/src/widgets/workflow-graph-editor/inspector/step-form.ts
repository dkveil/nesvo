import {
  workflowDefinitionLimits,
  stepDefinitionSchema,
  isChildWorkflowStep,
  workflowItemsSchema,
  type StepType,
} from '@nesvo/contracts';
import type { StepDraft } from '@/entities/workflow-graph';
export { stepTypeLabels as typeLabels } from '@/entities/workflow-graph';
import { schemaNotes, type NotesByField } from './field-notes';

export const stepFields = [
  'name',
  'type',
  'phase',
  'skill',
  'prompt_skill',
  'body',
  'timeout',
  'retries',
  'retry_backoff',
  'idempotent',
  'pr',
  'poll_interval',
  'repeat',
  'condition',
  'max_iterations',
  'probe',
  'on_fail',
  'needs',
  'effect',
  'session',
  'items',
  'policy',
  'max_depth',
] as const;

export const durationUnits = ['s', 'm', 'h'] as const;

export type DurationUnit = (typeof durationUnits)[number] | 'ms';

export const durationUnitLabels: Record<DurationUnit, string> = {
  ms: 'Milliseconds',
  s: 'Seconds',
  m: 'Minutes',
  h: 'Hours',
};

const DURATION_PARTS = /^(.*?)(ms|s|m|h)$/;
const DURATION_DIGITS = String(workflowDefinitionLimits.maxTimeoutMs).length;

export const splitDuration = (
  value: string,
): { amount: string; unit: DurationUnit } => {
  const match = DURATION_PARTS.exec(value);
  if (!match) return { amount: value, unit: 'm' };
  return { amount: match[1] ?? '', unit: match[2] as DurationUnit };
};

export const joinDuration = (amount: string, unit: DurationUnit) =>
  `${amount.replace(/\D/g, '').slice(0, DURATION_DIGITS)}${unit}`;

export const bodyLabels: Record<StepType, string> = {
  command: 'Command',
  action: 'Command',
  agent: 'Instructions',
  human: 'Description',
  'wait-ci': 'Notes',
  until: 'Notes',
  probe: 'Notes',
  session: 'First prompt',
  'fan-out': 'First prompt per item',
};

export const bodyPlaceholders: Record<StepType, string> = {
  command: 'bun run check',
  action: 'gh release create "$VERSION"',
  agent: 'What the agent checks and how it reports the verdict.',
  human: 'What the reviewer looks at before deciding.',
  'wait-ci': '',
  until: '',
  probe: '',
  session: 'Use {{ steps.prepare.outputs.task }} to insert an upstream output.',
  'fan-out': 'Implement stage {{ item.id }}. {{ item.task }}',
};

export const declaresEffect = (type: StepType) =>
  type === 'command' || type === 'action';

export const allowsRetries = (type: StepType) =>
  type !== 'human' && type !== 'until' && !isChildWorkflowStep(type);

export const withType = (step: StepDraft, type: StepType): StepDraft => ({
  ...step,
  type,
  probe: type === 'probe' ? step.probe : undefined,
  repeat: type === 'until' ? (step.repeat ?? []) : undefined,
  condition: type === 'until' ? (step.condition ?? '') : undefined,
  max_iterations: type === 'until' ? (step.max_iterations ?? 3) : undefined,
  pr: type === 'wait-ci' ? step.pr : undefined,
  poll_interval: type === 'wait-ci' ? step.poll_interval : undefined,
  skill: type === 'agent' ? step.skill : null,
  prompt_skill:
    type === 'agent' || isChildWorkflowStep(type)
      ? step.prompt_skill
      : undefined,
  retries: allowsRetries(type) ? step.retries : 0,
  retry_backoff: allowsRetries(type) ? step.retry_backoff : undefined,
  idempotent: allowsRetries(type) ? step.idempotent : undefined,
  session: isChildWorkflowStep(type)
    ? (step.session ?? {
        workflow: '',
        title: '',
        provider: 'Codex',
        model: 'default',
        mode: 'read-only',
      })
    : undefined,
  items:
    type === 'fan-out'
      ? (step.items ?? { kind: 'inline', values: [] })
      : undefined,
  policy:
    type === 'fan-out'
      ? (step.policy ?? {
          max_parallel: 1,
          min_free_ram_mb: 1024,
          min_plan_remaining_percent: 20,
          on_fail: 'fail-run',
        })
      : undefined,
  max_depth: isChildWorkflowStep(type) ? step.max_depth : undefined,
  itemsText: type === 'fan-out' ? step.itemsText : undefined,
  on_fail: type === 'human' ? 'stop' : step.on_fail,
  effect: declaresEffect(type) ? step.effect : 'local',
});

export const readInlineItems = (text: string) => {
  try {
    const parsed = workflowItemsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const stepNotes = (step: StepDraft): NotesByField => ({
  ...schemaNotes(
    stepDefinitionSchema.safeParse({
      name: step.name,
      type: step.type,
      phase: step.phase,
      skill: step.skill,
      prompt_skill: step.prompt_skill,
      timeout: step.timeout,
      retries: step.retries,
      retry_backoff: step.retry_backoff,
      idempotent: step.idempotent,
      pr: step.pr,
      poll_interval: step.poll_interval,
      repeat: step.repeat?.map(name => name.trim()),
      condition: step.condition,
      max_iterations: step.max_iterations,
      probe: step.probe,
      session: step.session,
      items: step.items,
      policy: step.policy,
      max_depth: step.max_depth,
      on_fail: step.on_fail,
      effect: step.effect,
      needs: step.needs,
      body: step.body,
    }),
  ),
  ...(step.items?.kind === 'inline' &&
  step.itemsText !== undefined &&
  !readInlineItems(step.itemsText)
    ? {
        items: [
          {
            severity: 'error' as const,
            message: 'Enter a JSON list of strings or flat objects.',
          },
        ],
      }
    : {}),
});

export const retryOptions = Array.from(
  { length: workflowDefinitionLimits.retries + 1 },
  (_, index) => index,
);
