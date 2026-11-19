import { z } from 'zod';
import { directCommandSchema } from './direct-command';
import {
  repositoryPatternSchema,
  repositoryRemoteSchema,
} from './repository-identity';

const path = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const branch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])(?<!\.lock)$/);

const providerScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('computer') }),
  z.strictObject({
    kind: z.literal('pattern'),
    pattern: repositoryPatternSchema,
  }),
  z.strictObject({ kind: z.literal('repository'), directory: path }),
]);

export const worktreeTaskFieldsSchema = z.strictObject({
  type: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,23}$/)
    .optional(),
  ticket: z
    .string()
    .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)?$/)
    .max(32)
    .optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .optional(),
});

const branchPolicy = z.strictObject({
  template: z
    .string()
    .min(1)
    .max(200)
    .regex(/^(?:[A-Za-z0-9._/-]|<(?:type|TICKET|slug|id)>)+$/u),
  validation: z
    .string()
    .min(3)
    .max(240)
    .refine(value => value.startsWith('^') && value.endsWith('$')),
});

const sharedFields = {
  version: z.literal(1),
  name: z.string().trim().min(1).max(100),
  scope: providerScope,
  branchPolicy: branchPolicy.optional(),
};

export const worktreeProviderDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...sharedFields, kind: z.literal('builtin') }),
  z.strictObject({
    ...sharedFields,
    kind: z.literal('external'),
    checkoutRoots: z.array(path).min(1).max(8),
    create: directCommandSchema,
    remove: directCommandSchema,
    list: directCommandSchema,
    status: directCommandSchema.optional(),
  }),
]);

export const sessionWorktreeBindingSchema = z.strictObject({
  version: z.literal(1),
  gitDirectory: path,
  repository: repositoryRemoteSchema.nullable(),
  checkout: path,
  root: path,
  ownership: z.enum(['created', 'adopted']),
  providerId: z.uuid(),
  providerKind: z.enum(['builtin', 'external']),
  revision: fingerprint,
  branch,
  base: commit,
});

export const attachWorktreeSchema = z.strictObject({
  checkout: path,
  branch,
  base: commit,
  providerId: z.uuid().nullable(),
  providerRevision: fingerprint.nullable(),
});

export type AttachWorktree = z.infer<typeof attachWorktreeSchema>;

export const worktreeProviderCheckoutSchema = z.strictObject({
  version: z.literal(1),
  path,
  branch,
  base: commit,
});
export const worktreeProviderRemovalSchema =
  worktreeProviderCheckoutSchema.extend({
    removed: z.literal(true),
  });
export const worktreeProviderListingSchema = z.strictObject({
  version: z.literal(1),
  checkouts: z
    .array(worktreeProviderCheckoutSchema.omit({ version: true }))
    .max(256),
});
export const worktreeProviderStatusSchema =
  worktreeProviderCheckoutSchema.extend({
    state: z.enum(['clean', 'dirty']),
  });

const action = { actionId: z.uuid() };
export const worktreeProviderInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({ action: z.literal('attachments'), directory: path }),
  z.strictObject({
    action: z.literal('inspect'),
    definition: worktreeProviderDefinitionSchema,
  }),
  z.strictObject({
    action: z.literal('approve'),
    ...action,
    definition: worktreeProviderDefinitionSchema,
    fingerprint,
  }),
  z.strictObject({
    action: z.literal('revoke'),
    ...action,
    providerId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal('effective'),
    directory: path,
    title: z.string().trim().min(1).max(100),
    branch: branch.optional(),
    fields: worktreeTaskFieldsSchema.optional(),
  }),
]);

const providerSummary = z.strictObject({
  providerId: z.uuid(),
  name: z.string().max(100),
  kind: z.enum(['builtin', 'external']),
  scope: providerScope,
  fingerprint,
});

const fileFingerprint = z.strictObject({
  actionId: z.uuid(),
  operation: z.enum([
    'approve',
    'revoke',
    'create',
    'remove',
    'list',
    'status',
    'adopt',
  ]),
  providerId: z.uuid(),
  fingerprint,
  sessionId: z.uuid().nullable(),
  state: z.enum(['pending', 'succeeded', 'failed', 'uncertain']),
  at: z.iso.datetime(),
  exitCode: z.number().int().nullable(),
  detail: z.string().max(1024).nullable(),
});

export const worktreeProviderReplySchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('attachments'),
    rows: z.array(attachWorktreeSchema.extend({ dirty: z.boolean() })).max(80),
    externalReason: z.string().max(1024).nullable(),
  }),
  z.strictObject({
    action: z.literal('read'),
    providers: z.array(providerSummary).max(128),
    history: z.array(fileFingerprint).max(100),
  }),
  z.strictObject({
    action: z.literal('inspect'),
    fingerprint,
    scope: z.string().max(4096),
    commands: z
      .array(
        z.strictObject({
          operation: z.enum(['create', 'remove', 'list', 'status']),
          executable: path,
          argv: z.array(z.string().max(4096)).max(64),
        }),
      )
      .max(4),
    roots: z.array(path).max(8),
  }),
  z.strictObject({ action: z.literal('approve'), provider: providerSummary }),
  z.strictObject({ action: z.literal('revoke') }),
  z.strictObject({
    action: z.literal('effective'),
    provider: providerSummary.nullable(),
    branch: branch.nullable(),
    reason: z.string().max(1024).nullable(),
  }),
]);

export type WorktreeProviderDefinition = z.infer<
  typeof worktreeProviderDefinitionSchema
>;
export type WorktreeProviderInput = z.infer<typeof worktreeProviderInputSchema>;
export type WorktreeProviderReply = z.infer<typeof worktreeProviderReplySchema>;
export type WorktreeTaskFields = z.infer<typeof worktreeTaskFieldsSchema>;
export type SessionWorktreeBinding = z.infer<
  typeof sessionWorktreeBindingSchema
>;
