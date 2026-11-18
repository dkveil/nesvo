import { z } from 'zod';
import {
  implicitEdges,
  WORKFLOW_EDGE_CONDITIONS,
  WORKFLOW_EDGE_PATTERN,
  workflowGraphLimits,
} from './graph';

export const workflowDefinitionLimits = {
  name: 64,
  body: 32_768,
  specBody: 65_536,
  specTitle: 100,
  description: 400,
  workflowSteps: 32,
  needs: 16,
  retries: 5,
  path: 4096,
  catalogSteps: 200,
  catalogWorkflows: 100,
  catalogSpecs: 100,
  notes: 4,
  issues: 200,
  issueMessage: 800,
  minTimeoutMs: 1000,
  maxTimeoutMs: 4 * 60 * 60 * 1000,
  edges: workflowGraphLimits.edges,
  layoutCoordinate: workflowGraphLimits.layoutCoordinate,
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
  return milliseconds >= workflowDefinitionLimits.minTimeoutMs &&
    milliseconds <= workflowDefinitionLimits.maxTimeoutMs
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
  .max(workflowDefinitionLimits.name)
  .regex(
    STEP_NAME_PATTERN,
    'Use lowercase letters, digits and single hyphens.',
  );
export const stepSkillSchema = z
  .string()
  .min(1)
  .max(workflowDefinitionLimits.name)
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
  retry_backoff: durationSchema.optional(),
  idempotent: z.boolean().optional(),
  retries: z
    .number()
    .int()
    .min(0)
    .max(workflowDefinitionLimits.retries)
    .default(0),
  on_fail: stepOnFailSchema.default('stop'),
  effect: stepEffectSchema.default('local'),
  needs: z
    .array(stepNeedSchema)
    .max(workflowDefinitionLimits.needs)
    .default([])
    .refine(values => !hasDuplicates(values), 'List each need once.'),
  body: z.string().max(workflowDefinitionLimits.body),
};

type StepRuleSubject = {
  type: z.infer<typeof stepTypeSchema>;
  skill: string | null;
  retries: number;
  retry_backoff?: string;
  idempotent?: boolean;
  effect: z.infer<typeof stepEffectSchema>;
  body: string;
};

const enforceStepRules = (value: StepRuleSubject, context: z.RefinementCtx) => {
  if (
    value.type === 'human' &&
    (value.retries !== 0 || value.retry_backoff || value.idempotent)
  )
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

const workflowStepNamesSchema = z
  .array(stepNameSchema)
  .min(1)
  .max(workflowDefinitionLimits.workflowSteps)
  .refine(values => !hasDuplicates(values), 'List each step once.');

const workflowDefinitionShape = {
  name: stepNameSchema,
  description: z.string().max(workflowDefinitionLimits.description).default(''),
  body: z.string().max(workflowDefinitionLimits.body).default(''),
};

export const workflowEdgeConditionSchema = z.enum(WORKFLOW_EDGE_CONDITIONS);
export const workflowEdgeSchema = z
  .string()
  .min(3)
  .max(workflowGraphLimits.edgeText)
  .regex(
    WORKFLOW_EDGE_PATTERN,
    'Write an edge as "<step> -> <step>" with an optional "on success", "on failure" or "on any".',
  );
const workflowEdgesSchema = z
  .array(workflowEdgeSchema)
  .max(workflowDefinitionLimits.edges);
const layoutCoordinateSchema = z
  .number()
  .int()
  .min(-workflowDefinitionLimits.layoutCoordinate)
  .max(workflowDefinitionLimits.layoutCoordinate);
export const workflowLayoutSchema = z
  .record(z.string(), z.tuple([layoutCoordinateSchema, layoutCoordinateSchema]))
  .refine(
    value =>
      Object.keys(value).length <= workflowDefinitionLimits.workflowSteps,
    `Place at most ${workflowDefinitionLimits.workflowSteps} steps in the layout.`,
  );

export const workflowDefinitionSchema = z.strictObject({
  ...workflowDefinitionShape,
  steps: workflowStepNamesSchema,
  edges: workflowEdgesSchema.optional(),
  layout: workflowLayoutSchema.optional(),
});

export const taskSpecSchema = z.strictObject({
  workflow: stepNameSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .max(workflowDefinitionLimits.specTitle)
    .optional(),
  body: z
    .string()
    .max(workflowDefinitionLimits.specBody)
    .refine(value => value.trim().length > 0, 'The task spec is empty.'),
});

export const definitionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const definitionScopeSchema = z.enum(['global', 'project']);
export const definitionKindSchema = z.enum(['step', 'workflow']);
const definitionPathSchema = z
  .string()
  .min(1)
  .max(workflowDefinitionLimits.path);

export const definitionSourceSchema = z.strictObject({
  scope: definitionScopeSchema,
  path: definitionPathSchema,
  contentHash: definitionHashSchema,
});

const definitionNotesSchema = z
  .array(z.string().min(1).max(workflowDefinitionLimits.issueMessage))
  .max(workflowDefinitionLimits.notes)
  .default([]);

export const resolvedStepSchema = stepDefinitionSchema.safeExtend({
  source: definitionSourceSchema,
  notes: definitionNotesSchema,
});

export const resolvedGraphEdgeSchema = z.strictObject({
  from: stepNameSchema,
  to: stepNameSchema,
  when: workflowEdgeConditionSchema,
});

export const resolvedGraphSchema = z.strictObject({
  explicit: z.boolean(),
  edges: z.array(resolvedGraphEdgeSchema).max(workflowDefinitionLimits.edges),
});

export const resolvedWorkflowSchema = z
  .strictObject({
    ...workflowDefinitionShape,
    source: definitionSourceSchema,
    notes: definitionNotesSchema,
    steps: z
      .array(resolvedStepSchema)
      .min(1)
      .max(workflowDefinitionLimits.workflowSteps),
    edges: workflowEdgesSchema.optional(),
    layout: workflowLayoutSchema.optional(),
    graph: resolvedGraphSchema.optional(),
  })
  .refine(value => !hasDuplicates(value.steps.map(step => step.name)), {
    path: ['steps'],
    message: 'List each step once.',
  })
  .transform(({ graph, ...workflow }) => ({
    ...workflow,
    graph: graph ?? { explicit: false, edges: implicitEdges(workflow.steps) },
  }));

export const definitionIssueSchema = z.strictObject({
  severity: z.enum(['error', 'warning']),
  path: z.string().max(workflowDefinitionLimits.path),
  line: z.number().int().positive().nullable(),
  message: z.string().min(1).max(workflowDefinitionLimits.issueMessage),
});

export const taskSpecSummarySchema = z.strictObject({
  workflow: stepNameSchema,
  title: z.string().max(workflowDefinitionLimits.specTitle).nullable(),
  source: definitionSourceSchema,
});

export const definitionCatalogSchema = z.strictObject({
  roots: z.strictObject({
    global: definitionPathSchema.nullable(),
    project: definitionPathSchema.nullable(),
  }),
  steps: z.array(resolvedStepSchema).max(workflowDefinitionLimits.catalogSteps),
  workflows: z
    .array(resolvedWorkflowSchema)
    .max(workflowDefinitionLimits.catalogWorkflows),
  specs: z
    .array(taskSpecSummarySchema)
    .max(workflowDefinitionLimits.catalogSpecs)
    .default([]),
  issues: z.array(definitionIssueSchema).max(workflowDefinitionLimits.issues),
});

export type StepType = z.infer<typeof stepTypeSchema>;
export type StepPhase = z.infer<typeof stepPhaseSchema>;
export type StepOnFail = z.infer<typeof stepOnFailSchema>;
export type StepEffect = z.infer<typeof stepEffectSchema>;
export type StepDefinition = z.infer<typeof stepDefinitionSchema>;
export type StepDefinitionInput = z.input<typeof stepDefinitionSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type DefinitionScope = z.infer<typeof definitionScopeSchema>;
export type DefinitionKind = z.infer<typeof definitionKindSchema>;
export type DefinitionSource = z.infer<typeof definitionSourceSchema>;
export type ResolvedStep = z.infer<typeof resolvedStepSchema>;
export type ResolvedWorkflow = z.infer<typeof resolvedWorkflowSchema>;
export type TaskSpecSummary = z.infer<typeof taskSpecSummarySchema>;
export type DefinitionIssue = z.infer<typeof definitionIssueSchema>;
export type DefinitionCatalog = z.infer<typeof definitionCatalogSchema>;
export type WorkflowEdgeCondition = z.infer<typeof workflowEdgeConditionSchema>;
export type WorkflowLayout = z.infer<typeof workflowLayoutSchema>;
export type ResolvedGraph = z.infer<typeof resolvedGraphSchema>;
