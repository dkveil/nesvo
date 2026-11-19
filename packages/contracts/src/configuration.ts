import { z } from 'zod';
import { decisionRouteSchema } from './decision-route';
import { colorSchemeSchema } from './appearance';
import { providerSchema, sessionModeSchema } from './sessions';
import { ruleEntrySchema } from './rule-entries';
import { createCostBudgetSchema } from './costs';
import { scheduledJobDefinitionSchema } from './scheduled-jobs';
import { moveSessionGroupSchema, sessionGroupSchema } from './session-groups';
import { allowScopeSchema } from './claude-autonomy';
import {
  externalInboxDeviceSchema,
  externalInboxTokenSchema,
} from './external-inbox';

export const configurationRevision = 1;
export const configurationFrameLimit = 416 * 1024;
export const configurationFileAreas = [
  'inbox-rules',
  'workflows',
  'steps',
  'lessons',
  'gate-rules',
] as const;
export const configurationFileAreaSchema = z.enum(configurationFileAreas);
export const configurationRecordAreas = [
  'session-groups',
  'budgets',
  'automations',
] as const;
export const configurationRecordAreaSchema = z.enum(configurationRecordAreas);
export const configurationAreaSchema = z.enum([
  'settings',
  'defaults',
  'appearance',
  'authority',
  'setup-profile',
  'setup-profile-file',
  ...configurationFileAreas,
  ...configurationRecordAreas,
]);
export const configurationVerbSchema = z.enum(['read', 'propose', 'apply']);
export const configurationLimits = {
  document: 64 * 1024,
  preview: 48 * 1024,
  page: 25,
  pendingPerDevice: 10,
  pendingPerHost: 200,
} as const;

const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const path = z.string().min(1).max(4096);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const configurationAuthoritySubjectSchema = z.enum([
  'session-mode',
  'claude-allow-rule',
  'devices',
  'phone-access',
  'computers',
]);
export type ConfigurationAuthoritySubject = z.infer<
  typeof configurationAuthoritySubjectSchema
>;
const authorityValue = z.union([
  sessionModeSchema,
  z.strictObject({
    kind: z.literal('claude-allow-rule'),
    scope: allowScopeSchema,
  }),
  z.strictObject({
    kind: z.literal('devices'),
    name: z.string().trim().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal('phone-access'),
    action: z.enum(['enable', 'pair']),
  }),
  z.strictObject({
    kind: z.literal('computers'),
    name: z.string().trim().min(1).max(80),
  }),
]);
const fileScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('project'), root: path }),
]);

export const configurationTargetSchema = z.discriminatedUnion('area', [
  z.strictObject({ area: configurationRecordAreaSchema, id: z.uuid() }),
  z.strictObject({
    area: z.literal('authority'),
    subject: configurationAuthoritySubjectSchema,
    id: z.string().min(1).max(200),
  }),
  z.strictObject({
    area: z.literal('settings'),
    key: z.enum([
      'inbox-routing',
      'workflow-learning',
      'notifications',
      'keep-running',
    ]),
  }),
  z.strictObject({
    area: z.literal('setup-profile'),
    key: z.literal('selection'),
  }),
  z.strictObject({
    area: z.literal('setup-profile-file'),
    key: z.enum(['routing', 'shared-routing']),
  }),
  z.strictObject({
    area: z.literal('defaults'),
    key: z.enum(['folder', 'new-session']),
  }),
  z.strictObject({
    area: z.literal('appearance'),
    key: z.literal('color-scheme'),
  }),
  z.strictObject({
    area: configurationFileAreaSchema,
    scope: fileScope,
    name: key,
  }),
]);

export const configurationVersionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('absent') }),
  z.strictObject({ type: z.literal('hash'), hash }),
  z.strictObject({
    type: z.literal('revision'),
    revision: z.number().int().nonnegative(),
  }),
]);

export const configurationSessionDefaultsSchema = z
  .strictObject({
    provider: providerSchema.nullable(),
    model: z.string().min(1).max(200).nullable(),
    mode: sessionModeSchema.exclude(['full-access']).nullable(),
    worktree: z.boolean(),
  })
  .refine(
    value => !!value.provider || (!value.model && !value.mode),
    'Select a provider for the model and mode.',
  );

export const configurationProfileSchema = z.strictObject({
  colorScheme: colorSchemeSchema.optional(),
  keepRunning: z.boolean().optional(),
  notifications: z.boolean().optional(),
  newSession: configurationSessionDefaultsSchema.optional(),
});
export const configurationProfileInputSchema = z.strictObject({
  action: z.enum(['read', 'seed', 'save']),
  values: configurationProfileSchema.default({}),
});
export type ConfigurationProfile = z.infer<typeof configurationProfileSchema>;

export const configurationValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('authority'), value: authorityValue }),
  z.strictObject({
    kind: z.literal('session-groups'),
    value: sessionGroupSchema
      .pick({ name: true, parentId: true, defaults: true })
      .extend({ position: moveSessionGroupSchema.shape.position }),
  }),
  z.strictObject({ kind: z.literal('budgets'), value: createCostBudgetSchema }),
  z.strictObject({
    kind: z.literal('automations'),
    value: scheduledJobDefinitionSchema,
  }),
  z.strictObject({
    kind: z.literal('entry'),
    value: ruleEntrySchema.omit({ id: true, type: true, provenance: true }),
  }),
  z.strictObject({
    kind: z.literal('new-session'),
    value: configurationSessionDefaultsSchema,
  }),
  z.strictObject({
    kind: z.literal('markdown'),
    document: z.string().min(1).max(configurationLimits.document),
  }),
  z.strictObject({ kind: z.literal('route'), value: decisionRouteSchema }),
  z.strictObject({
    kind: z.literal('setup-profile'),
    value: z.strictObject({ path: path.nullable(), digest: hash.nullable() }),
  }),
  z.strictObject({ kind: z.literal('enabled'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('folder'), value: path.nullable() }),
  z.strictObject({
    kind: z.literal('color-scheme'),
    value: z.enum(['system', 'light', 'dark']),
  }),
]);

export const configurationMutationSchema = z
  .strictObject({
    actionId: z.uuid(),
    target: configurationTargetSchema,
    operation: z.enum(['create', 'update', 'delete']),
    baseVersion: configurationVersionSchema,
    draft: configurationValueSchema.nullable(),
  })
  .superRefine((input, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (
      (input.operation === 'create') !==
      (input.baseVersion.type === 'absent')
    )
      issue('baseVersion', 'Only creation requires an absent base version.');
    if ((input.operation === 'delete') !== (input.draft === null))
      issue('draft', 'Supply a draft for creation or update.');
    const target = input.target;
    const kind =
      'id' in target
        ? target.area
        : 'scope' in target
          ? target.area === 'lessons' || target.area === 'gate-rules'
            ? 'entry'
            : 'markdown'
          : target.area === 'setup-profile'
            ? target.area
            : target.area === 'appearance'
              ? 'color-scheme'
              : target.area === 'defaults'
                ? target.key
                : target.key === 'inbox-routing' ||
                    target.area === 'setup-profile-file'
                  ? 'route'
                  : 'enabled';
    if (input.draft && input.draft.kind !== kind)
      issue('draft', 'The value does not match the target.');
    if (
      target.area === 'authority' &&
      input.draft?.kind === 'authority' &&
      (typeof input.draft.value === 'string'
        ? target.subject !== 'session-mode'
        : target.subject !== input.draft.value.kind)
    )
      issue('draft', 'The authority proposal does not match its subject.');
    if (
      ('key' in target || target.area === 'authority') &&
      input.operation !== 'update'
    )
      issue('operation', 'This setting supports updates.');
    if (
      input.baseVersion.type !== 'absent' &&
      input.baseVersion.type !==
        ('scope' in target || target.area === 'setup-profile-file'
          ? 'hash'
          : 'revision')
    )
      issue('baseVersion', 'The version does not match the target.');
  });

export const configurationSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('system'),
    source: z.literal('setup-profile'),
  }),
  z.strictObject({ kind: z.literal('owner') }),
  z.strictObject({ kind: z.literal('assistant'), sessionId: z.uuid() }),
  z.strictObject({
    kind: z.literal('device'),
    deviceId: z.uuid(),
    name: z.string().min(1).max(64),
  }),
]);

export const configurationStatusSchema = z.enum([
  'pending',
  'applied',
  'dismissed',
  'conflicted',
  'undone',
  'inspection-required',
]);
const sessionModeConfirmationSchema = z.strictObject({
  sessionId: z.uuid(),
  modeRevision: z.number().int().positive(),
  from: sessionModeSchema,
  to: sessionModeSchema,
});
export const configurationDecisionSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  actionId: z.uuid(),
  decision: z.enum(['accept', 'dismiss', 'edit']),
  draft: configurationValueSchema.nullable().optional(),
  confirmAuthority: z.boolean().default(false),
  confirmSessionMode: sessionModeConfirmationSchema.optional(),
  reviewRevocation: z.boolean().default(false),
});
export const configurationInspectDraftSchema = configurationDecisionSchema.pick(
  { id: true, revision: true },
);
export const configurationOwnerFlowLinkSchema = z.strictObject({
  ...configurationInspectDraftSchema.shape,
  actionId: z.uuid(),
  reviewRevocation: z.boolean().default(false),
});
export const configurationOwnerEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('full-access'), sessionId: z.uuid() }),
  z.strictObject({
    kind: z.literal('claude-allow-rule'),
    sessionId: z.uuid(),
    runId: z.uuid(),
    requestId: z.string().min(1).max(200),
    fingerprint: hash,
    scope: allowScopeSchema,
  }),
  z.strictObject({ kind: z.literal('devices') }),
  z.strictObject({
    kind: z.literal('phone-access'),
    action: z.enum(['enable', 'pair']),
  }),
  z.strictObject({ kind: z.literal('computers') }),
]);
export const configurationOwnerFlowStartSchema =
  configurationOwnerFlowLinkSchema.extend({
    effect: configurationOwnerEffectSchema,
  });
export const configurationOwnerFlowOutcomeSchema = z.strictObject({
  id: z.uuid(),
  description: z.string().min(1).max(200),
  resourceId: z.uuid().optional(),
});
export const configurationOwnerFlowFinishSchema = z.strictObject({
  claim: z.uuid(),
  outcome: configurationOwnerFlowOutcomeSchema.omit({ id: true }).nullable(),
});
export type ConfigurationOwnerFlowLink = z.input<
  typeof configurationOwnerFlowLinkSchema
>;
export type ConfigurationOwnerFlowStart = z.output<
  typeof configurationOwnerFlowStartSchema
>;
export type ConfigurationOwnerFlowFinish = z.output<
  typeof configurationOwnerFlowFinishSchema
>;
export const configurationUndoSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  actionId: z.uuid(),
  confirmAuthority: z.boolean().default(false),
  confirmSessionMode: sessionModeConfirmationSchema.optional(),
});

export const configurationIssueSchema = z.strictObject({
  field: z.string().max(100),
  message: z.string().max(400),
});
export const configurationErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    'unauthorized',
    'unsupported',
    'invalid-request',
    'conflict',
    'busy',
    'review-required',
    'unavailable',
    'rate-limit',
    'pending-limit',
  ]),
  message: z.string().max(400),
  issues: z.array(configurationIssueSchema).max(20),
});

export const configurationDiffSchema = z.strictObject({
  text: z.string().max(configurationLimits.preview),
  truncated: z.boolean(),
});

export const configurationChangeSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  target: configurationTargetSchema,
  label: z.string().max(160).optional(),
  operation: configurationMutationSchema.shape.operation,
  baseVersion: configurationVersionSchema,
  resultingVersion: configurationVersionSchema.nullable(),
  source: configurationSourceSchema,
  status: configurationStatusSchema,
  classification: z.enum(['direct', 'review', 'authority']),
  sessionMode: sessionModeConfirmationSchema
    .extend({ provider: providerSchema })
    .optional(),
  ownerEffect: configurationOwnerEffectSchema.optional(),
  outcome: configurationOwnerFlowOutcomeSchema.omit({ id: true }).optional(),
  diff: configurationDiffSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  decidedBy: z.enum(['owner', 'device', 'system']).nullable(),
});

export const configurationReceiptSchema = configurationChangeSchema.pick({
  id: true,
  revision: true,
  status: true,
  resultingVersion: true,
});
export const configurationHistoryInputSchema = z.strictObject({
  after: z.number().int().nonnegative().optional(),
  area: configurationAreaSchema.optional(),
  status: configurationStatusSchema.optional(),
});
export const configurationHistorySchema = z.strictObject({
  changes: z.array(configurationChangeSchema).max(configurationLimits.page),
  next: z.number().int().positive().nullable(),
});
export const configurationReadSchema = z.strictObject({
  target: configurationTargetSchema,
  version: configurationVersionSchema,
  value: configurationValueSchema.nullable(),
  withheld: z.boolean(),
  operations: z.array(configurationMutationSchema.shape.operation).max(3),
});
export const configurationListInputSchema = z.strictObject({
  area: configurationAreaSchema,
  project: path.optional(),
  cursor: z.string().min(1).max(100).optional(),
});
export const configurationGrantSchema = z
  .strictObject({
    area: configurationAreaSchema,
    verbs: z.array(configurationVerbSchema).min(1).max(3),
    global: z.boolean(),
    projects: z.array(path).max(16),
  })
  .refine(
    grant => grant.global || grant.projects.length > 0,
    'Select a global or project scope.',
  );
export const configurationEnrollSchema = z
  .strictObject({
    name: externalInboxDeviceSchema.shape.name,
    grants: z
      .array(configurationGrantSchema)
      .min(1)
      .max(configurationAreaSchema.options.length),
  })
  .refine(
    input =>
      new Set(input.grants.map(grant => grant.area)).size ===
      input.grants.length,
    'Use one grant per area.',
  );
export const configurationDeviceSchema = externalInboxDeviceSchema.extend({
  grants: configurationEnrollSchema.shape.grants,
});
export const configurationDevicesSchema = z
  .array(configurationDeviceSchema)
  .max(20);
export const configurationEnrollmentSchema = z.strictObject({
  device: configurationDeviceSchema,
  token: externalInboxTokenSchema,
});
export const configurationCapabilitiesSchema = z.strictObject({
  instanceId: z.uuid(),
  revision: z.literal(configurationRevision),
  grants: z
    .array(configurationGrantSchema)
    .max(configurationAreaSchema.options.length),
  directApply: z.array(configurationTargetSchema).max(10),
  nameOnlyGroupRename: z.boolean(),
  authoritySubjects: z
    .array(configurationAuthoritySubjectSchema)
    .max(5)
    .default([]),
});
const configurationListSchema = z.strictObject({
  targets: z
    .array(
      configurationReadSchema.pick({
        target: true,
        version: true,
        withheld: true,
      }),
    )
    .max(configurationLimits.page),
  next: z.string().max(100).nullable(),
});
export const configurationCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('capabilities') }),
  z.strictObject({
    operation: z.literal('list'),
    input: configurationListInputSchema,
  }),
  z.strictObject({
    operation: z.literal('get'),
    target: configurationTargetSchema,
  }),
  z.strictObject({
    operation: z.literal('propose'),
    mutation: configurationMutationSchema,
  }),
  z.strictObject({
    operation: z.literal('apply'),
    mutation: configurationMutationSchema,
  }),
  z.strictObject({ operation: z.literal('status'), id: z.uuid() }),
]);
export const configurationRequestSchema = z.strictObject({
  token: externalInboxTokenSchema,
  command: configurationCommandSchema,
});
export const configurationResultSchema = z.union([
  configurationErrorSchema,
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('owner-flow'),
    claim: z.uuid(),
    change: configurationChangeSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('owner-outcome'),
    receipt: configurationReceiptSchema.nullable(),
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('draft'),
    draft: configurationValueSchema.nullable(),
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('capabilities'),
    capabilities: configurationCapabilitiesSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('list'),
    page: configurationListSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('read'),
    target: configurationReadSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('history'),
    page: configurationHistorySchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('submission'),
    receipt: configurationReceiptSchema,
    change: configurationChangeSchema.nullable(),
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('receipt'),
    receipt: configurationReceiptSchema,
  }),
]);
export type ConfigurationResult = z.infer<typeof configurationResultSchema>;
export type ConfigurationCommand = z.infer<typeof configurationCommandSchema>;
export type ConfigurationRequest = z.infer<typeof configurationRequestSchema>;
export type ConfigurationGrant = z.infer<typeof configurationGrantSchema>;
export type ConfigurationDevice = z.infer<typeof configurationDeviceSchema>;
export type ConfigurationEnrollment = z.infer<
  typeof configurationEnrollmentSchema
>;
export type ConfigurationEnroll = z.infer<typeof configurationEnrollSchema>;
export type ConfigurationListInput = z.infer<
  typeof configurationListInputSchema
>;

export type ConfigurationTarget = z.infer<typeof configurationTargetSchema>;
export type ConfigurationArea = ConfigurationTarget['area'];
export type ConfigurationVersion = z.infer<typeof configurationVersionSchema>;
export type ConfigurationValue = z.infer<typeof configurationValueSchema>;
export type ConfigurationMutation = z.infer<typeof configurationMutationSchema>;
export type ConfigurationSource = z.infer<typeof configurationSourceSchema>;
export type ConfigurationDecision = z.infer<typeof configurationDecisionSchema>;
export type ConfigurationUndo = z.infer<typeof configurationUndoSchema>;
export type ConfigurationOwnerEffect = z.infer<
  typeof configurationOwnerEffectSchema
>;
export type ConfigurationError = z.infer<typeof configurationErrorSchema>;
export type ConfigurationChange = z.infer<typeof configurationChangeSchema>;
export type ConfigurationReceipt = z.infer<typeof configurationReceiptSchema>;
export type ConfigurationHistoryInput = z.infer<
  typeof configurationHistoryInputSchema
>;
