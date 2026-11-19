import { z } from 'zod';
import { inboxRuleFieldsSchema, inboxSettingsSchema } from './inbox-rules';
import { providerSchema, SESSION_BRANCH_PATTERN } from './sessions';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const label = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const setupProfilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const setupProfileDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u)
  .refine(path => path.split('/').every(part => part !== '.' && part !== '..'));
const repo = z
  .string()
  .min(3)
  .max(400)
  .regex(/^[a-z0-9][a-z0-9.:-]*\/[a-zA-Z0-9_.*-]+(?:\/[a-zA-Z0-9_.*-]+)*$/u);
const branch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?:[A-Za-z0-9._/-]|<(?:type|TICKET|slug|id)>)+$/u)
  .refine(template =>
    SESSION_BRANCH_PATTERN.test(
      template.replaceAll(/<(?:type|TICKET|slug|id)>/gu, 'input'),
    ),
  );

export const setupSecretReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('env'),
    name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
  }),
  z.strictObject({
    kind: z.literal('keychain'),
    service: label,
    account: label,
  }),
]);

const environmentVariable = z.strictObject({
  name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
  from: setupSecretReferenceSchema,
});
const command = z.strictObject({
  executable: setupProfilePathSchema,
  argv: z
    .array(
      z
        .string()
        .max(4096)
        .regex(/^[^\p{Cc}\p{Cf}`]*$/u)
        .refine(value => !/\$|%[A-Z_][A-Z0-9_]*%|:\/\/[^/\s]*@/iu.test(value)),
    )
    .max(64),
  files: z.array(relativePath).max(16).optional(),
  environment: z.array(environmentVariable).max(16).optional(),
  timeoutMs: z.number().int().min(100).max(300000).optional(),
  maxOutputBytes: z.number().int().min(1024).max(262144).optional(),
});
const disabled = z.strictObject({ id, disabled: z.literal(true) });
const withIds = <T extends z.ZodType<{ id: string }>>(item: T) =>
  z
    .array(z.union([item, disabled]))
    .max(48)
    .superRefine((entries, ctx) => {
      const keys = new Set<string>();
      entries.forEach(({ id }, index) => {
        if (keys.has(id))
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: 'Duplicate ID in this layer.',
          });
        keys.add(id);
      });
    });
const gitScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('computer') }),
  z.strictObject({ kind: z.literal('pattern'), pattern: repo }),
  z.strictObject({
    kind: z.literal('repository'),
    directory: setupProfilePathSchema,
  }),
]);
const worktree = z.discriminatedUnion('kind', [
  z.strictObject({
    id,
    name: label,
    scope: gitScope,
    branch: branch.optional(),
    kind: z.literal('builtin'),
  }),
  z.strictObject({
    id,
    name: label,
    scope: gitScope,
    branch: branch.optional(),
    kind: z.literal('external'),
    checkoutRoots: z.array(setupProfilePathSchema).min(1).max(8),
    create: command,
    remove: command,
    list: command,
    status: command.optional(),
  }),
]);
const recipe = z.strictObject({
  id,
  name: label,
  repository: repo,
  provider: id.optional(),
  copy: z.array(relativePath).max(48).optional(),
  setup: z.array(command).max(12).optional(),
  cleanup: z.array(command).max(12).optional(),
  ports: z
    .array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/))
    .max(8)
    .optional(),
});
const integration = z.strictObject({
  id,
  provider: providerSchema,
  account: id.optional(),
  repository: repo.optional(),
  hooks: z
    .array(z.strictObject({ event: label, selector: label }))
    .max(16)
    .optional(),
  tools: z
    .array(z.strictObject({ server: label, tool: label }))
    .max(32)
    .optional(),
});
const source = z.strictObject({
  id,
  name: label,
  device: id,
  targets: z.array(id).min(1).max(32),
  destination: z.enum(['session', 'inbox']),
  watcher: command.optional(),
});
const inboxRule = z.strictObject({
  id,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('global') }),
    z.strictObject({ kind: z.literal('project'), repository: repo }),
  ]),
  order: z.number().int().min(0).max(999),
  definition: inboxRuleFieldsSchema,
});
const limit = z.strictObject({
  id,
  provider: providerSchema,
  account: id.optional(),
  window: label,
  threshold: z.number().min(0).max(100),
  effect: z.enum(['warn', 'hold']),
});
const automation = z.strictObject({
  id,
  name: label,
  timeZone: label,
  schedule: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  directory: setupProfilePathSchema,
  task: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('workflow'), name: id }),
    z.strictObject({ kind: z.literal('command'), command }),
    z.strictObject({ kind: z.literal('ritual'), name: id }),
  ]),
  check: command.optional(),
  maxRunsPerDay: z.number().int().min(1).max(24).optional(),
  desired: z.enum(['paused', 'active']).optional(),
  askFirst: z.boolean().optional(),
});

export const setupProfileDocumentSchema = z.strictObject({
  version: z.literal(1),
  include: z
    .strictObject({
      shared: relativePath.optional(),
      machine: relativePath.optional(),
    })
    .optional(),
  worktrees: withIds(worktree).optional(),
  recipes: withIds(recipe).optional(),
  repositoryTrust: withIds(
    z.strictObject({ id, pattern: repo, effect: z.enum(['allow', 'deny']) }),
  ).optional(),
  integrations: withIds(integration).optional(),
  externalMessages: withIds(source).optional(),
  sessionControl: z
    .strictObject({
      maxSessions: z.number().int().min(1).max(8).optional(),
      maxDepth: z.number().int().min(1).max(2).optional(),
      workers: z.enum(['read-only', 'ask']).optional(),
      wake: z.enum(['manual', 'ask']).optional(),
    })
    .optional(),
  inbox: z
    .strictObject({
      defaultRoute: inboxSettingsSchema.shape.defaultRoute.optional(),
      rules: withIds(inboxRule).optional(),
    })
    .optional(),
  limits: withIds(limit).optional(),
  automations: withIds(automation).optional(),
  github: withIds(
    z.strictObject({
      id,
      repository: repo,
      checkout: setupProfilePathSchema.optional(),
    }),
  ).optional(),
});
export type SetupProfileDocument = z.output<typeof setupProfileDocumentSchema>;
export const setupProfileCollectionKeys = [
  'worktrees',
  'recipes',
  'repositoryTrust',
  'integrations',
  'externalMessages',
  'limits',
  'automations',
  'github',
] as const;

export const setupProfileDeclarationSchema = z.strictObject({
  key: z.string().min(1).max(110),
  source: setupProfilePathSchema,
  field: z.string().min(1).max(140),
  label,
  revision: setupProfileDigestSchema,
  state: z.enum(['ordinary', 'pending', 'masked', 'unsupported']),
});
export const setupProfileReviewSchema = z.strictObject({
  instanceId: z.uuid().nullable(),
  path: setupProfilePathSchema,
  revision: setupProfileDigestSchema.nullable(),
  effectiveRevision: z.number().int().nonnegative(),
  status: z.enum([
    'absent',
    'candidate',
    'current',
    'changed',
    'invalid',
    'unsupported',
  ]),
  activePath: setupProfilePathSchema.nullable(),
  files: z
    .array(
      z.strictObject({
        layer: z.enum(['shared', 'machine', 'entry']),
        path: setupProfilePathSchema,
        revision: setupProfileDigestSchema,
      }),
    )
    .max(3),
  declarations: z.array(setupProfileDeclarationSchema).max(500),
  issues: z
    .array(
      z.strictObject({
        file: setupProfilePathSchema,
        field: z.string().max(140),
        line: z.number().int().positive().optional(),
        reason: z.string().max(300),
      }),
    )
    .max(20),
  routing: z.strictObject({
    desired: inboxSettingsSchema.shape.defaultRoute.nullable(),
    effective: inboxSettingsSchema.shape.defaultRoute,
    managed: z.boolean(),
    source: setupProfilePathSchema.nullable(),
    writesTo: setupProfilePathSchema.nullable(),
  }),
});
export type SetupProfileReview = z.output<typeof setupProfileReviewSchema>;
export type SetupProfileDeclaration = z.output<
  typeof setupProfileDeclarationSchema
>;

export const setupProfileInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('inspect'),
    file: setupProfilePathSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('apply'),
    file: setupProfilePathSchema,
    instanceId: z.uuid().nullable(),
    revision: setupProfileDigestSchema,
    effectiveRevision: z.number().int().nonnegative(),
    actionId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal('edit-routing'),
    instanceId: z.uuid(),
    file: setupProfilePathSchema,
    revision: setupProfileDigestSchema,
    effectiveRevision: z.number().int().nonnegative(),
    route: inboxSettingsSchema.shape.defaultRoute,
    layer: z.enum(['machine', 'shared']),
    actionId: z.uuid(),
  }),
]);
export type SetupProfileInput = z.output<typeof setupProfileInputSchema>;
