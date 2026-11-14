import {
  pipelineDefinitionLimits,
  stepDefinitionSchema,
  type StepType,
} from '@nesvo/contracts';
import type { StepDraft } from '@/entities/pipeline-graph';
import { schemaNotes } from './field-notes';

export const stepFields = [
  'name',
  'type',
  'phase',
  'skill',
  'body',
  'timeout',
  'retries',
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
const DURATION_DIGITS = 7;

export const splitDuration = (
  value: string,
): { amount: string; unit: DurationUnit } => {
  const match = DURATION_PARTS.exec(value);
  if (!match) return { amount: value, unit: 'm' };
  return { amount: match[1] ?? '', unit: match[2] as DurationUnit };
};

export const joinDuration = (amount: string, unit: DurationUnit) =>
  `${amount.replace(/\s+/g, '').slice(0, DURATION_DIGITS)}${unit}`;

export const bodyLabels: Record<StepType, string> = {
  command: 'Command',
  action: 'Command',
  agent: 'Instructions',
  human: 'Description',
};

export const bodyPlaceholders: Record<StepType, string> = {
  command: 'bun run check',
  action: 'gh release create "$VERSION"',
  agent: 'What the agent checks and how it reports the verdict.',
  human: 'What the reviewer looks at before deciding.',
};

export const typeLabels: Record<StepType, string> = {
  command: 'Command',
  agent: 'Agent',
  human: 'Human',
  action: 'Action',
};

export const declaresEffect = (type: StepType) =>
  type === 'command' || type === 'action';

export const withType = (step: StepDraft, type: StepType): StepDraft => ({
  ...step,
  type,
  skill: type === 'agent' ? step.skill : null,
  retries: type === 'human' ? 0 : step.retries,
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
      on_fail: step.on_fail,
      effect: step.effect,
      needs: step.needs,
      body: step.body,
    }),
  );

export const retryOptions = Array.from(
  { length: pipelineDefinitionLimits.retries + 1 },
  (_, index) => index,
);
