import {
  workflowDefinitionLimits,
  stepDefinitionSchema,
  type StepType,
} from '@nesvo/contracts';
import type { StepDraft } from '@/entities/workflow-graph';
export { stepTypeLabels as typeLabels } from '@/entities/workflow-graph';
import { schemaNotes } from './field-notes';

export const stepFields = [
  'name',
  'type',
  'phase',
  'skill',
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
};

export const bodyPlaceholders: Record<StepType, string> = {
  command: 'bun run check',
  action: 'gh release create "$VERSION"',
  agent: 'What the agent checks and how it reports the verdict.',
  human: 'What the reviewer looks at before deciding.',
  'wait-ci': '',
  until: '',
  probe: '',
};

export const declaresEffect = (type: StepType) =>
  type === 'command' || type === 'action';

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
  retries: type === 'human' || type === 'until' ? 0 : step.retries,
  retry_backoff:
    type === 'human' || type === 'until' ? undefined : step.retry_backoff,
  idempotent: type === 'human' ? undefined : step.idempotent,
  on_fail: type === 'human' ? 'stop' : step.on_fail,
  effect: declaresEffect(type) ? step.effect : 'local',
});

export const stepNotes = (step: StepDraft) =>
  schemaNotes(
    stepDefinitionSchema.safeParse({
      name: step.name,
      type: step.type,
      phase: step.phase,
      skill: step.skill,
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
      on_fail: step.on_fail,
      effect: step.effect,
      needs: step.needs,
      body: step.body,
    }),
  );

export const retryOptions = Array.from(
  { length: workflowDefinitionLimits.retries + 1 },
  (_, index) => index,
);
