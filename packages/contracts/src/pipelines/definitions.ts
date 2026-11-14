import { z } from 'zod';
import {
  implicitEdges,
  PIPELINE_EDGE_CONDITIONS,
  PIPELINE_EDGE_PATTERN,
  pipelineGraphLimits,
} from './graph';

export const pipelineDefinitionLimits = {
  name: 64,
  body: 32_768,
  specBody: 65_536,
  specTitle: 100,
  description: 400,
  pipelineSteps: 32,
  needs: 16,
  retries: 5,
  path: 4096,
  catalogSteps: 200,
  catalogPipelines: 100,
  catalogSpecs: 100,
  notes: 4,
  issues: 200,
  issueMessage: 800,
  minTimeoutMs: 1000,
  maxTimeoutMs: 4 * 60 * 60 * 1000,
  edges: pipelineGraphLimits.edges,
  layoutCoordinate: pipelineGraphLimits.layoutCoordinate,
} as const;

export const STEP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const STEP_SKILL_PATTERN =
  /^(?:[a-z0-9]+(?:-[a-z0-9]+)*:)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const STEP_DURATION_PATTERN = /^([1-9]\d*)(ms|s|m|h)$/;
export const STEP_NEED_PATTERN = /^(?:env:[A-Z_][A-Z0-9_]*|browser)$/;

const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

export const parseDurationMs = (value: string): number | null => {
  const match = STEP_DURATION_PATTERN.exec(value);
  if (!match) return null;
  const milliseconds =
    Number(match[1]) *
    DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS];
  return milliseconds >= pipelineDefinitionLimits.minTimeoutMs &&
    milliseconds <= pipelineDefinitionLimits.maxTimeoutMs
    ? milliseconds
    : null;
};

export const stepTypeSchema = z.enum(['command', 'agent', 'human', 'action']);
export const stepPhaseSchema = z.enum(['plan', 'pre-done', 'pre-push']);
export const stepOnFailSchema = z.enum(['fix', 'stop']);
export const stepEffectSchema = z.enum(['local', 'external']);
export const stepNameSchema = z
  .string()
  .min(1)
  .max(pipelineDefinitionLimits.name)
  .regex(
    STEP_NAME_PATTERN,
    'Use lowercase letters, digits and single hyphens.',
  );
export const stepSkillSchema = z
  .string()
  .min(1)
  .max(pipelineDefinitionLimits.name)
  .regex(STEP_SKILL_PATTERN, 'Use a skill name such as code-review.');
export const durationSchema = z
  .string()
  .regex(STEP_DURATION_PATTERN, 'Use a duration such as 90s, 15m or 2h.')
  .refine(
    value => parseDurationMs(value) !== null,
    'Use a duration between 1s and 4h.',
  );
export const stepNeedSchema = z
  .string()
  .regex(STEP_NEED_PATTERN, 'Use browser or env:NAME.');

const hasDuplicates = (values: readonly string[]) =>
  new Set(values).size !== values.length;

const stepDefinitionShape = {
  name: stepNameSchema,
  type: stepTypeSchema,
  phase: stepPhaseSchema,
  skill: stepSkillSchema.nullable().default(null),
  timeout: durationSchema.default('15m'),
  retries: z
    .number()
    .int()
    .min(0)
    .max(pipelineDefinitionLimits.retries)
    .default(0),
  on_fail: stepOnFailSchema.default('stop'),
  effect: stepEffectSchema.default('local'),
  needs: z
    .array(stepNeedSchema)
    .max(pipelineDefinitionLimits.needs)
    .default([])
    .refine(values => !hasDuplicates(values), 'List each need once.'),
  body: z.string().max(pipelineDefinitionLimits.body),
};

type StepRuleSubject = {
  type: z.infer<typeof stepTypeSchema>;
  skill: string | null;
  retries: number;
  effect: z.infer<typeof stepEffectSchema>;
  body: string;
};

const enforceStepRules = (value: StepRuleSubject, context: z.RefinementCtx) => {
  if (value.type === 'human' && value.retries !== 0)
    context.addIssue({
      code: 'custom',
      path: ['retries'],
      message: 'Human steps do not retry.',
    });
  if (
    value.effect === 'external' &&
    value.type !== 'command' &&
    value.type !== 'action'
  )
    context.addIssue({
      code: 'custom',
      path: ['effect'],
      message: 'Only command and action steps declare an external effect.',
    });
  if (value.type !== 'agent' && value.skill !== null)
    context.addIssue({
      code: 'custom',
      path: ['skill'],
      message: 'Only agent steps invoke a skill.',
    });
  if (!value.body.trim() && (value.type !== 'agent' || value.skill === null))
    context.addIssue({
      code: 'custom',
      path: ['body'],
      message:
        value.type === 'agent'
          ? 'Agent steps need instructions or a skill.'
          : 'The step body is empty.',
    });
};

export const stepDefinitionSchema = z
  .strictObject(stepDefinitionShape)
  .superRefine(enforceStepRules);

const pipelineStepNamesSchema = z
  .array(stepNameSchema)
  .min(1)
  .max(pipelineDefinitionLimits.pipelineSteps)
  .refine(values => !hasDuplicates(values), 'List each step once.');

const pipelineDefinitionShape = {
  name: stepNameSchema,
  description: z.string().max(pipelineDefinitionLimits.description).default(''),
  body: z.string().max(pipelineDefinitionLimits.body).default(''),
};

export const pipelineEdgeConditionSchema = z.enum(PIPELINE_EDGE_CONDITIONS);
export const pipelineEdgeSchema = z
  .string()
  .min(3)
  .max(pipelineGraphLimits.edgeText)
  .regex(
    PIPELINE_EDGE_PATTERN,
    'Write an edge as "<step> -> <step>" with an optional "on success", "on failure" or "on any".',
  );
const pipelineEdgesSchema = z
  .array(pipelineEdgeSchema)
  .max(pipelineDefinitionLimits.edges);
const layoutCoordinateSchema = z
  .number()
  .int()
  .min(-pipelineDefinitionLimits.layoutCoordinate)
  .max(pipelineDefinitionLimits.layoutCoordinate);
export const pipelineLayoutSchema = z
  .record(z.string(), z.tuple([layoutCoordinateSchema, layoutCoordinateSchema]))
  .refine(
    value =>
      Object.keys(value).length <= pipelineDefinitionLimits.pipelineSteps,
    `Place at most ${pipelineDefinitionLimits.pipelineSteps} steps in the layout.`,
  );

export const pipelineDefinitionSchema = z.strictObject({
  ...pipelineDefinitionShape,
  steps: pipelineStepNamesSchema,
  edges: pipelineEdgesSchema.optional(),
  layout: pipelineLayoutSchema.optional(),
});

export const taskSpecSchema = z.strictObject({
  pipeline: stepNameSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .max(pipelineDefinitionLimits.specTitle)
    .optional(),
  body: z
    .string()
    .max(pipelineDefinitionLimits.specBody)
    .refine(value => value.trim().length > 0, 'The task spec is empty.'),
});

export const definitionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const definitionScopeSchema = z.enum(['global', 'project']);
export const definitionKindSchema = z.enum(['step', 'pipeline']);
const definitionPathSchema = z
  .string()
  .min(1)
  .max(pipelineDefinitionLimits.path);

export const definitionSourceSchema = z.strictObject({
  scope: definitionScopeSchema,
  path: definitionPathSchema,
  contentHash: definitionHashSchema,
});

const definitionNotesSchema = z
  .array(z.string().min(1).max(pipelineDefinitionLimits.issueMessage))
  .max(pipelineDefinitionLimits.notes)
  .default([]);

export const resolvedStepSchema = stepDefinitionSchema.safeExtend({
  source: definitionSourceSchema,
  notes: definitionNotesSchema,
});

export const resolvedGraphEdgeSchema = z.strictObject({
  from: stepNameSchema,
  to: stepNameSchema,
  when: pipelineEdgeConditionSchema,
});

export const resolvedGraphSchema = z.strictObject({
  explicit: z.boolean(),
  edges: z.array(resolvedGraphEdgeSchema).max(pipelineDefinitionLimits.edges),
});

export const resolvedPipelineSchema = z
  .strictObject({
    ...pipelineDefinitionShape,
    source: definitionSourceSchema,
    notes: definitionNotesSchema,
    steps: z
      .array(resolvedStepSchema)
      .min(1)
      .max(pipelineDefinitionLimits.pipelineSteps),
    edges: pipelineEdgesSchema.optional(),
    layout: pipelineLayoutSchema.optional(),
    graph: resolvedGraphSchema.optional(),
  })
  .refine(value => !hasDuplicates(value.steps.map(step => step.name)), {
    path: ['steps'],
    message: 'List each step once.',
  })
  .transform(({ graph, ...pipeline }) => ({
    ...pipeline,
    graph: graph ?? { explicit: false, edges: implicitEdges(pipeline.steps) },
  }));

export const definitionIssueSchema = z.strictObject({
  severity: z.enum(['error', 'warning']),
  path: z.string().max(pipelineDefinitionLimits.path),
  line: z.number().int().positive().nullable(),
  message: z.string().min(1).max(pipelineDefinitionLimits.issueMessage),
});

export const taskSpecSummarySchema = z.strictObject({
  pipeline: stepNameSchema,
  title: z.string().max(pipelineDefinitionLimits.specTitle).nullable(),
  source: definitionSourceSchema,
});

export const definitionCatalogSchema = z.strictObject({
  roots: z.strictObject({
    global: definitionPathSchema.nullable(),
    project: definitionPathSchema.nullable(),
  }),
  steps: z.array(resolvedStepSchema).max(pipelineDefinitionLimits.catalogSteps),
  pipelines: z
    .array(resolvedPipelineSchema)
    .max(pipelineDefinitionLimits.catalogPipelines),
  specs: z
    .array(taskSpecSummarySchema)
    .max(pipelineDefinitionLimits.catalogSpecs)
    .default([]),
  issues: z.array(definitionIssueSchema).max(pipelineDefinitionLimits.issues),
});

export type StepType = z.infer<typeof stepTypeSchema>;
export type StepPhase = z.infer<typeof stepPhaseSchema>;
export type StepOnFail = z.infer<typeof stepOnFailSchema>;
export type StepEffect = z.infer<typeof stepEffectSchema>;
export type StepDefinition = z.infer<typeof stepDefinitionSchema>;
export type StepDefinitionInput = z.input<typeof stepDefinitionSchema>;
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type DefinitionScope = z.infer<typeof definitionScopeSchema>;
export type DefinitionKind = z.infer<typeof definitionKindSchema>;
export type DefinitionSource = z.infer<typeof definitionSourceSchema>;
export type ResolvedStep = z.infer<typeof resolvedStepSchema>;
export type ResolvedPipeline = z.infer<typeof resolvedPipelineSchema>;
export type TaskSpecSummary = z.infer<typeof taskSpecSummarySchema>;
export type DefinitionIssue = z.infer<typeof definitionIssueSchema>;
export type DefinitionCatalog = z.infer<typeof definitionCatalogSchema>;
export type PipelineEdgeCondition = z.infer<typeof pipelineEdgeConditionSchema>;
export type PipelineLayout = z.infer<typeof pipelineLayoutSchema>;
export type ResolvedGraph = z.infer<typeof resolvedGraphSchema>;
