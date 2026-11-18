import { z } from 'zod';
import {
  workflowShareBundleSchema,
  workflowShareFileSchema,
  workflowShareIdSchema,
  workflowShareLimits,
} from '../workflow-share';
import {
  definitionHashSchema,
  definitionIssueSchema,
  definitionKindSchema,
  definitionScopeSchema,
  stepNameSchema,
  stepTypeSchema,
  workflowDefinitionLimits,
} from './definitions';

export const workflowSharingLimits = {
  url: 2048,
  findings: 50,
  excerpt: 240,
  links: 200,
} as const;

export const DEFAULT_SHARE_ORIGIN = 'https://nesvo.dev';

export const prepareWorkflowShareSchema = z.strictObject({
  directory: z.string().trim().max(workflowDefinitionLimits.path),
  name: stepNameSchema,
});

export const workflowShareFindingSchema = z.strictObject({
  fileName: z.string().max(workflowShareLimits.fileName),
  line: z.number().int().positive(),
  label: z.string().min(1).max(80),
  excerpt: z.string().max(workflowSharingLimits.excerpt),
});

export const workflowShareDraftSchema = z.strictObject({
  name: stepNameSchema,
  description: z.string().max(workflowDefinitionLimits.description).nullable(),
  scope: definitionScopeSchema,
  workflow: workflowShareFileSchema,
  steps: z
    .array(
      workflowShareFileSchema.extend({
        type: stepTypeSchema,
        scope: definitionScopeSchema,
      }),
    )
    .max(workflowShareLimits.steps),
  findings: z
    .array(workflowShareFindingSchema)
    .max(workflowSharingLimits.findings),
  findingCount: z.number().int().nonnegative(),
});

export const workflowImportTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('project'),
    directory: z.string().trim().min(1).max(workflowDefinitionLimits.path),
  }),
  z.strictObject({ scope: z.literal('global') }),
]);

export const workflowImportOverwriteSchema = z.strictObject({
  kind: definitionKindSchema,
  name: stepNameSchema,
  expectedHash: definitionHashSchema,
});

export const importWorkflowBundleSchema = z.strictObject({
  target: workflowImportTargetSchema,
  bundle: workflowShareBundleSchema,
  workflowName: stepNameSchema,
  overwrite: z
    .array(workflowImportOverwriteSchema)
    .max(workflowShareLimits.steps + 1)
    .default([]),
  write: z.boolean(),
});

export const workflowImportFileSchema = z.strictObject({
  kind: definitionKindSchema,
  name: stepNameSchema,
  state: z.enum(['new', 'same', 'different']),
  currentHash: definitionHashSchema.nullable(),
  currentContent: z.string().max(workflowShareLimits.fileBytes).nullable(),
  path: z.string().max(workflowDefinitionLimits.path),
});

export const workflowImportResultSchema = z.strictObject({
  status: z.enum(['ready', 'blocked', 'saved', 'failed']),
  scope: definitionScopeSchema,
  root: z.string().max(workflowDefinitionLimits.path),
  directory: z.string().max(workflowDefinitionLimits.path),
  workflowName: stepNameSchema,
  suggestedName: stepNameSchema.nullable(),
  files: z.array(workflowImportFileSchema).max(workflowShareLimits.steps + 1),
  issues: z.array(definitionIssueSchema).max(workflowDefinitionLimits.issues),
  findings: z
    .array(workflowShareFindingSchema)
    .max(workflowSharingLimits.findings),
  findingCount: z.number().int().nonnegative(),
});

export const workflowShareSettingsSchema = z.strictObject({
  origin: z.string().max(workflowSharingLimits.url),
  defaultOrigin: z.string().max(workflowSharingLimits.url),
  overriddenByEnvironment: z.boolean(),
});

export const sharedWorkflowLinkSchema = z.strictObject({
  id: workflowShareIdSchema,
  name: stepNameSchema,
  url: z.string().max(workflowSharingLimits.url),
  origin: z.string().max(workflowSharingLimits.url),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const workflowSharePreparedSchema = z.strictObject({
  draftId: z.uuid(),
  origin: z.string().max(workflowSharingLimits.url),
  bytes: z.number().int().nonnegative(),
  draft: workflowShareDraftSchema,
  sizeIssue: z.string().max(400).nullable(),
});

export const workflowImportOfferSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    importId: z.uuid(),
    shareId: workflowShareIdSchema,
    origin: z.string().max(workflowSharingLimits.url),
    bundle: workflowShareBundleSchema,
  }),
  z.strictObject({
    status: z.literal('refused'),
    message: z.string().min(1).max(400),
  }),
]);

export const saveWorkflowImportSchema = z.strictObject({
  importId: z.uuid(),
  target: workflowImportTargetSchema,
  workflowName: stepNameSchema,
  overwrite: z
    .array(workflowImportOverwriteSchema)
    .max(workflowShareLimits.steps + 1)
    .default([]),
  write: z.boolean(),
});

export type PrepareWorkflowShareInput = z.infer<
  typeof prepareWorkflowShareSchema
>;
export type WorkflowShareFinding = z.infer<typeof workflowShareFindingSchema>;
export type WorkflowShareDraft = z.infer<typeof workflowShareDraftSchema>;
export type WorkflowImportTarget = z.infer<typeof workflowImportTargetSchema>;
export type WorkflowImportOverwrite = z.infer<
  typeof workflowImportOverwriteSchema
>;
export type ImportWorkflowBundleInput = z.input<
  typeof importWorkflowBundleSchema
>;
export type WorkflowImportFile = z.infer<typeof workflowImportFileSchema>;
export type WorkflowImportResult = z.infer<typeof workflowImportResultSchema>;
export type WorkflowShareSettings = z.infer<typeof workflowShareSettingsSchema>;
export type SharedWorkflowLink = z.infer<typeof sharedWorkflowLinkSchema>;
export type WorkflowSharePrepared = z.infer<typeof workflowSharePreparedSchema>;
export type WorkflowImportOffer = z.infer<typeof workflowImportOfferSchema>;
export type SaveWorkflowImportInput = z.input<typeof saveWorkflowImportSchema>;

export type WorkflowSharingApi = {
  settings: () => Promise<WorkflowShareSettings>;
  setOrigin: (origin: string | null) => Promise<WorkflowShareSettings>;
  prepare: (
    hostId: string,
    input: PrepareWorkflowShareInput,
  ) => Promise<WorkflowSharePrepared>;
  upload: (draftId: string) => Promise<SharedWorkflowLink>;
  links: () => Promise<SharedWorkflowLink[]>;
  revoke: (id: string) => Promise<SharedWorkflowLink[]>;
  forget: (id: string) => Promise<SharedWorkflowLink[]>;
  takeImports: () => Promise<WorkflowImportOffer[]>;
  onImportAvailable: (listener: () => void) => () => void;
  importWorkflow: (
    input: SaveWorkflowImportInput,
  ) => Promise<WorkflowImportResult>;
  dismissImport: (importId: string) => Promise<void>;
  pickFolder: () => Promise<string | null>;
};
