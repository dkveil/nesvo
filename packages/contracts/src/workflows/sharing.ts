import { z } from 'zod';
import {
  definitionHashSchema,
  definitionIssueSchema,
  definitionKindSchema,
  definitionScopeSchema,
  stepNameSchema,
  stepTypeSchema,
  workflowDefinitionLimits,
} from './definitions';

export const workflowShareLimits = {
  fileBytes: 65_536,
  totalBytes: 262_144,
  steps: workflowDefinitionLimits.workflowSteps,
  fileName: workflowDefinitionLimits.name + 3,
  appVersion: 64,
  shareId: 64,
  revokeToken: 256,
  url: 2048,
  findings: 50,
  excerpt: 240,
  links: 200,
  expiryDays: 7,
} as const;

export const SHARE_FILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
export const DEFAULT_SHARE_ORIGIN = 'https://nesvo.dev';

const utf8Bytes = (value: string) => {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

const shareFileSchema = z.strictObject({
  fileName: z
    .string()
    .max(workflowShareLimits.fileName)
    .regex(SHARE_FILE_NAME_PATTERN),
  content: z
    .string()
    .min(1)
    .max(workflowShareLimits.fileBytes)
    .refine(
      value => utf8Bytes(value) <= workflowShareLimits.fileBytes,
      `A shared file is at most ${workflowShareLimits.fileBytes / 1024} KiB.`,
    ),
});

export const workflowShareBundleSchema = z
  .strictObject({
    version: z.literal(1),
    name: stepNameSchema,
    description: z
      .string()
      .max(workflowDefinitionLimits.description)
      .optional(),
    workflow: shareFileSchema,
    steps: z.array(shareFileSchema).min(1).max(workflowShareLimits.steps),
    createdWith: z.strictObject({
      app: z.literal('nesvo'),
      version: z.string().min(1).max(workflowShareLimits.appVersion),
    }),
  })
  .superRefine((bundle, context) => {
    if (bundle.workflow.fileName !== `${bundle.name}.md`)
      context.addIssue({
        code: 'custom',
        path: ['workflow', 'fileName'],
        message: 'The workflow file must be named after the workflow.',
      });
    const names = bundle.steps.map(step => step.fileName);
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'List each step file once.',
      });
    const total = [bundle.workflow, ...bundle.steps].reduce(
      (sum, file) => sum + utf8Bytes(file.content),
      0,
    );
    if (total > workflowShareLimits.totalBytes)
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: `A shared workflow is at most ${workflowShareLimits.totalBytes / 1024} KiB in total.`,
      });
  });

export const workflowShareIdSchema = z.string().regex(SHARE_ID_PATTERN);

export const workflowShareCreatedSchema = z.strictObject({
  id: workflowShareIdSchema,
  url: z.url({ protocol: /^https?$/ }).max(workflowShareLimits.url),
  revokeToken: z.string().min(16).max(workflowShareLimits.revokeToken),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const prepareWorkflowShareSchema = z.strictObject({
  directory: z.string().trim().max(workflowDefinitionLimits.path),
  name: stepNameSchema,
});

export const workflowShareFindingSchema = z.strictObject({
  fileName: z.string().max(workflowShareLimits.fileName),
  line: z.number().int().positive(),
  label: z.string().min(1).max(80),
  excerpt: z.string().max(workflowShareLimits.excerpt),
});

export const workflowShareDraftSchema = z.strictObject({
  name: stepNameSchema,
  description: z.string().max(workflowDefinitionLimits.description).nullable(),
  scope: definitionScopeSchema,
  workflow: shareFileSchema,
  steps: z
    .array(
      shareFileSchema.extend({
        type: stepTypeSchema,
        scope: definitionScopeSchema,
      }),
    )
    .min(1)
    .max(workflowShareLimits.steps),
  findings: z
    .array(workflowShareFindingSchema)
    .max(workflowShareLimits.findings),
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
    .max(workflowShareLimits.findings),
  findingCount: z.number().int().nonnegative(),
});

export const workflowShareSettingsSchema = z.strictObject({
  origin: z.string().max(workflowShareLimits.url),
  defaultOrigin: z.string().max(workflowShareLimits.url),
  overriddenByEnvironment: z.boolean(),
});

export const sharedWorkflowLinkSchema = z.strictObject({
  id: workflowShareIdSchema,
  name: stepNameSchema,
  url: z.string().max(workflowShareLimits.url),
  origin: z.string().max(workflowShareLimits.url),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const workflowSharePreparedSchema = z.strictObject({
  draftId: z.uuid(),
  origin: z.string().max(workflowShareLimits.url),
  bytes: z.number().int().nonnegative(),
  draft: workflowShareDraftSchema,
  sizeIssue: z.string().max(400).nullable(),
});

export const workflowImportOfferSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    importId: z.uuid(),
    shareId: workflowShareIdSchema,
    origin: z.string().max(workflowShareLimits.url),
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

export type WorkflowShareBundle = z.infer<typeof workflowShareBundleSchema>;
export type WorkflowShareCreated = z.infer<typeof workflowShareCreatedSchema>;
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
