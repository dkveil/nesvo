import { z } from 'zod';
import { providerSchema } from '../sessions';
import { stepNameSchema, stepPhaseSchema, stepTypeSchema } from './definitions';

export const stepResultLimits = {
  summary: 4000,
  evidence: 32,
  evidenceLabel: 120,
  evidencePath: 1024,
  evidenceText: 4000,
  evidenceUrl: 2048,
  outputs: 16,
  outputKey: 64,
  outputValue: 4000,
  agentSummary: 2000,
  agentEvidence: 32,
  agentReference: 400,
  agentNote: 1000,
  agentOutputs: 8,
} as const;

export const STEP_OUTPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export const stepVerdictSchema = z.enum([
  'pass',
  'fail',
  'blocked',
  'done',
  'error',
]);

const GATE_VERDICTS: readonly StepVerdict[] = ['pass', 'fail', 'blocked'];
const ACTION_VERDICTS: readonly StepVerdict[] = ['done', 'error', 'blocked'];

export const evidenceSchema = z
  .strictObject({
    kind: z.enum(['log', 'text', 'file', 'screenshot', 'link', 'steps']),
    label: z.string().min(1).max(stepResultLimits.evidenceLabel),
    path: z.string().min(1).max(stepResultLimits.evidencePath).nullable(),
    text: z.string().min(1).max(stepResultLimits.evidenceText).nullable(),
    url: z.string().min(1).max(stepResultLimits.evidenceUrl).nullable(),
  })
  .refine(
    value => value.path !== null || value.text !== null || value.url !== null,
    'Evidence needs a path, text or link.',
  );

const outputsSchema = (count: number, value: number) =>
  z
    .record(
      z.string().max(stepResultLimits.outputKey).regex(STEP_OUTPUT_KEY_PATTERN),
      z.string().max(value),
    )
    .refine(
      outputs => Object.keys(outputs).length <= count,
      `Return at most ${count} outputs.`,
    );

export const stepCostSchema = z.strictObject({
  usd: z.number().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  provider: providerSchema.nullable(),
});

export const stepResultSchema = z
  .strictObject({
    name: stepNameSchema,
    type: stepTypeSchema,
    phase: stepPhaseSchema,
    status: stepVerdictSchema,
    summary: z.string().max(stepResultLimits.summary),
    evidence: z.array(evidenceSchema).max(stepResultLimits.evidence),
    outputs: outputsSchema(
      stepResultLimits.outputs,
      stepResultLimits.outputValue,
    ),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
    cost: stepCostSchema,
    attempt: z.number().int().positive(),
  })
  .refine(
    value =>
      (value.type === 'action' ? ACTION_VERDICTS : GATE_VERDICTS).includes(
        value.status,
      ),
    {
      path: ['status'],
      message:
        'Gates report pass, fail or blocked; actions report done, error or blocked.',
    },
  );

export const agentVerdictSchema = z.strictObject({
  status: z.enum(['pass', 'fail', 'blocked']),
  summary: z.string().min(1).max(stepResultLimits.agentSummary),
  evidence: z
    .array(
      z.strictObject({
        reference: z.string().min(1).max(stepResultLimits.agentReference),
        note: z.string().max(stepResultLimits.agentNote),
      }),
    )
    .min(1)
    .max(stepResultLimits.agentEvidence),
  outputs: outputsSchema(
    stepResultLimits.agentOutputs,
    stepResultLimits.outputValue,
  ).optional(),
});

export const agentVerdictJsonSchema = () =>
  z.toJSONSchema(agentVerdictSchema, { io: 'input' });

export type StepVerdict = z.infer<typeof stepVerdictSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type StepCost = z.infer<typeof stepCostSchema>;
export type StepResult = z.infer<typeof stepResultSchema>;
export type AgentVerdict = z.infer<typeof agentVerdictSchema>;
