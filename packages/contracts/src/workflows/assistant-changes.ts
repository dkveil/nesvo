import { z } from 'zod';
import {
  scheduledJobLimits,
  scheduledJobProviderSchema,
  scheduledJobScheduleSchema,
  scheduledJobTimeZoneSchema,
  scheduledJobWorkflowSchema,
} from '../scheduled-jobs';
import {
  definitionHashSchema,
  definitionIssueSchema,
  definitionScopeSchema,
  stepNameSchema,
  workflowDefinitionLimits,
} from './definitions';

export const assistantChangeLimits = {
  summary: 400,
  message: 800,
  document: 65_536,
  history: 500,
  issues: 50,
  relativePath: 200,
} as const;

export const ASSISTANT_CHANGE_FENCE = 'nesvo-change';

export const assistantChangeKindSchema = z.enum([
  'workflow',
  'step',
  'automation',
  'lesson',
  'gate-rule',
  'decision',
  'project-profile',
]);
export const assistantChangeOpSchema = z.enum(['create', 'update', 'delete']);
export const assistantChangeStatusSchema = z.enum(['applied', 'undone']);

const summarySchema = z
  .string()
  .trim()
  .min(1)
  .max(assistantChangeLimits.summary);
const revisionSchema = z.number().int().positive();

export const assistantChangeTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('definition'),
    root: definitionScopeSchema,
    path: z
      .string()
      .regex(
        /^(?:(?:steps|workflows|lessons|gate-rules|decisions)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|project\.md)$/,
      )
      .max(assistantChangeLimits.relativePath),
    name: stepNameSchema,
  }),
  z.strictObject({
    type: z.literal('automation'),
    automationId: z.uuid(),
  }),
]);

export const assistantChangeVersionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hash'), hash: definitionHashSchema }),
  z.strictObject({ type: z.literal('revision'), revision: revisionSchema }),
]);

type ChangeRuleSubject = {
  kind: z.infer<typeof assistantChangeKindSchema>;
  op: z.infer<typeof assistantChangeOpSchema>;
  target: z.infer<typeof assistantChangeTargetSchema>;
  before: z.infer<typeof assistantChangeVersionSchema> | null;
  after: z.infer<typeof assistantChangeVersionSchema> | null;
};

const enforceChangeRules = (
  value: ChangeRuleSubject,
  context: z.RefinementCtx,
) => {
  const automation = value.kind === 'automation';
  if (automation !== (value.target.type === 'automation'))
    context.addIssue({
      code: 'custom',
      path: ['target'],
      message:
        'Automations target an automation; steps and workflows target a definition file.',
    });
  if (
    value.target.type === 'definition' &&
    ((value.target.path === 'project.md') !==
      (value.kind === 'project-profile') ||
      (value.kind === 'project-profile' && value.target.root !== 'project'))
  )
    context.addIssue({
      code: 'custom',
      path: ['target'],
      message: 'A Project profile targets .agents/project.md.',
    });
  const versionType = automation ? 'revision' : 'hash';
  for (const key of ['before', 'after'] as const) {
    const version = value[key];
    if (version && version.type !== versionType)
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `Use a ${versionType} version for this change.`,
      });
  }
  if ((value.op === 'create') !== (value.before === null))
    context.addIssue({
      code: 'custom',
      path: ['before'],
      message: 'Only a create has no previous version.',
    });
  if ((value.op === 'delete') !== (value.after === null))
    context.addIssue({
      code: 'custom',
      path: ['after'],
      message: 'Only a delete has no resulting version.',
    });
};

export const assistantChangeSchema = z
  .strictObject({
    conversationId: z.uuid(),
    messageId: z.uuid(),
    changeId: z.uuid(),
    sequence: z.number().int().positive(),
    directory: z.string().min(1).max(workflowDefinitionLimits.path),
    mappingRoot: z
      .string()
      .min(1)
      .max(workflowDefinitionLimits.path)
      .optional(),
    kind: assistantChangeKindSchema,
    op: assistantChangeOpSchema,
    target: assistantChangeTargetSchema,
    before: assistantChangeVersionSchema.nullable(),
    after: assistantChangeVersionSchema.nullable(),
    summary: summarySchema,
    createdBy: z.enum(['assistant', 'owner', 'gate-rule-proposal']),
    at: z.iso.datetime(),
    status: assistantChangeStatusSchema,
    undoneAt: z.iso.datetime().nullable(),
  })
  .superRefine(enforceChangeRules);

export const assistantChangeRefusalSchema = z.strictObject({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  kind: assistantChangeKindSchema.nullable(),
  op: assistantChangeOpSchema.nullable(),
  target: assistantChangeTargetSchema.nullable(),
  summary: z.string().max(assistantChangeLimits.summary),
  reason: z.enum(['invalid', 'conflict', 'unsafe', 'unavailable']),
  issues: z.array(definitionIssueSchema).max(assistantChangeLimits.issues),
  at: z.iso.datetime(),
});

export const assistantChangeEventSchema = z.strictObject({
  change: assistantChangeSchema,
});

export const assistantChangeRefusedEventSchema = z.strictObject({
  refusal: assistantChangeRefusalSchema,
});

export const assistantUndoSchema = z.strictObject({
  conversationId: z.uuid(),
  changeId: z.uuid(),
});

export const assistantUndoResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('undone'),
    change: assistantChangeSchema,
  }),
  z.strictObject({
    status: z.literal('conflict'),
    changeId: z.uuid(),
    current: assistantChangeVersionSchema.nullable(),
    message: z.string().min(1).max(assistantChangeLimits.message),
  }),
  z.strictObject({
    status: z.literal('refused'),
    changeId: z.uuid(),
    issues: z
      .array(definitionIssueSchema)
      .min(1)
      .max(assistantChangeLimits.issues),
  }),
]);

export const listAssistantChangesSchema = z.strictObject({
  conversationId: z.uuid(),
});

export const assistantChangeHistorySchema = z.strictObject({
  conversationId: z.uuid(),
  changes: z.array(assistantChangeSchema).max(assistantChangeLimits.history),
});

export const assistantAutomationDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(scheduledJobLimits.name),
  prompt: z.string().trim().max(scheduledJobLimits.prompt).default(''),
  provider: scheduledJobProviderSchema,
  model: z.string().trim().min(1).max(scheduledJobLimits.model),
  effort: z
    .string()
    .trim()
    .min(1)
    .max(scheduledJobLimits.effort)
    .nullable()
    .default(null),
  schedule: scheduledJobScheduleSchema,
  timeZone: scheduledJobTimeZoneSchema,
  timeoutMinutes: z
    .number()
    .int()
    .min(scheduledJobLimits.minTimeoutMinutes)
    .max(scheduledJobLimits.maxTimeoutMinutes)
    .default(scheduledJobLimits.defaultTimeoutMinutes),
  workflow: scheduledJobWorkflowSchema.nullable().default(null),
  active: z.boolean().optional(),
});

export const assistantDefinitionOperationSchema = z.strictObject({
  kind: z.enum(['step', 'workflow']),
  op: assistantChangeOpSchema,
  scope: definitionScopeSchema,
  name: stepNameSchema,
  basedOnHash: definitionHashSchema.nullable(),
  document: z.string().max(assistantChangeLimits.document).nullable(),
  summary: summarySchema,
});

export const assistantAutomationOperationSchema = z.strictObject({
  kind: z.literal('automation'),
  op: assistantChangeOpSchema,
  automationId: z.uuid().nullable(),
  basedOnRevision: revisionSchema.nullable(),
  automation: assistantAutomationDraftSchema.nullable(),
  summary: summarySchema,
});

export const assistantOperationSchema = z.union([
  assistantDefinitionOperationSchema,
  assistantAutomationOperationSchema,
]);

export const assistantOperationJsonSchema = () =>
  z.toJSONSchema(assistantOperationSchema, { io: 'input' });

export type AssistantChangeKind = z.infer<typeof assistantChangeKindSchema>;
export type AssistantChangeOp = z.infer<typeof assistantChangeOpSchema>;
export type AssistantChangeStatus = z.infer<typeof assistantChangeStatusSchema>;
export type AssistantChangeTarget = z.infer<typeof assistantChangeTargetSchema>;
export type AssistantChangeVersion = z.infer<
  typeof assistantChangeVersionSchema
>;
export type AssistantChange = z.infer<typeof assistantChangeSchema>;
export type AssistantChangeRefusal = z.infer<
  typeof assistantChangeRefusalSchema
>;
export type AssistantUndoInput = z.infer<typeof assistantUndoSchema>;
export type AssistantUndoResult = z.infer<typeof assistantUndoResultSchema>;
export type ListAssistantChangesInput = z.infer<
  typeof listAssistantChangesSchema
>;
export type AssistantChangeHistory = z.infer<
  typeof assistantChangeHistorySchema
>;
export type AssistantAutomationDraft = z.infer<
  typeof assistantAutomationDraftSchema
>;
export type AssistantDefinitionOperation = z.infer<
  typeof assistantDefinitionOperationSchema
>;
export type AssistantAutomationOperation = z.infer<
  typeof assistantAutomationOperationSchema
>;
export type AssistantOperation = z.infer<typeof assistantOperationSchema>;
