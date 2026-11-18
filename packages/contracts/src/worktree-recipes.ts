import { z } from 'zod';

export const worktreeRecipeLimits = {
  recipes: 100,
  name: 80,
  patterns: 64,
  patternLength: 512,
  command: 16 * 1024,
  variables: 64,
  variableName: 128,
  variableValue: 4096,
  ports: 16,
  maxFiles: 1000,
  maxBytes: 512 * 1024 * 1024,
  setupTimeoutSeconds: 4 * 60 * 60,
  cleanupTimeoutSeconds: 60 * 60,
  output: 64 * 1024,
  error: 2000,
} as const;

export const worktreeRecipeDefaults = {
  maxFiles: 200,
  maxBytes: 64 * 1024 * 1024,
  setupTimeoutSeconds: 10 * 60,
  cleanupTimeoutSeconds: 2 * 60,
  portRange: { from: 41000, to: 41999 },
} as const;

export const WORKTREE_RECIPE_RESERVED_PREFIX = 'NESVO_';

const directorySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const patternSchema = z
  .string()
  .trim()
  .min(1)
  .max(worktreeRecipeLimits.patternLength)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Use one pattern per line.');

const commandSchema = z
  .string()
  .max(worktreeRecipeLimits.command)
  .regex(/^[^\u0000]*$/);

const variableSchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      'Use letters, digits and underscores, starting with a letter or underscore.',
    )
    .max(worktreeRecipeLimits.variableName)
    .refine(
      name => !name.toUpperCase().startsWith(WORKTREE_RECIPE_RESERVED_PREFIX),
      `Names starting with ${WORKTREE_RECIPE_RESERVED_PREFIX} are reserved.`,
    ),
  value: z
    .string()
    .max(worktreeRecipeLimits.variableValue)
    .regex(/^[^\u0000]*$/),
});
export type WorktreeRecipeVariable = z.infer<typeof variableSchema>;

const portSchema = z.number().int().min(1024).max(65535);

const resourcesSchema = z
  .strictObject({
    ports: z.number().int().min(0).max(worktreeRecipeLimits.ports),
    portRange: z
      .strictObject({ from: portSchema, to: portSchema })
      .refine(range => range.to >= range.from, {
        message: 'The range must end at or after its first port.',
        path: ['to'],
      }),
    tag: z.boolean(),
    tempDirectory: z.boolean(),
  })
  .refine(
    resources =>
      resources.portRange.to - resources.portRange.from + 1 >= resources.ports,
    {
      message: 'The port range is smaller than the number of ports.',
      path: ['portRange'],
    },
  );

const contentShape = {
  copy: z.strictObject({
    patterns: z.array(patternSchema).max(worktreeRecipeLimits.patterns),
    maxFiles: z.number().int().min(1).max(worktreeRecipeLimits.maxFiles),
    maxBytes: z.number().int().min(1).max(worktreeRecipeLimits.maxBytes),
  }),
  setup: z.strictObject({
    command: commandSchema,
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(worktreeRecipeLimits.setupTimeoutSeconds),
  }),
  cleanup: z.strictObject({
    command: commandSchema,
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(worktreeRecipeLimits.cleanupTimeoutSeconds),
  }),
  environment: z
    .array(variableSchema)
    .max(worktreeRecipeLimits.variables)
    .refine(
      variables =>
        new Set(variables.map(variable => variable.name.toUpperCase())).size ===
        variables.length,
      'Each variable name can appear once.',
    ),
  resources: resourcesSchema,
};

export const worktreeRecipeContentSchema = z.strictObject(contentShape);
export type WorktreeRecipeContent = z.infer<typeof worktreeRecipeContentSchema>;

export const worktreeRecipeRepositorySchema = z.strictObject({
  key: z.string().min(1).max(4096),
  kind: z.enum(['remote', 'path']),
  label: z.string().min(1).max(4096),
});
export type WorktreeRecipeRepository = z.infer<
  typeof worktreeRecipeRepositorySchema
>;

const recipeIdentityShape = {
  id: z.uuid(),
  name: z.string().trim().min(1).max(worktreeRecipeLimits.name),
  repository: worktreeRecipeRepositorySchema,
  sha256: hashSchema,
};

export const worktreeRecipeSchema = z.strictObject({
  ...recipeIdentityShape,
  ...contentShape,
  sourceDirectory: directorySchema.nullable(),
  approved: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type WorktreeRecipe = z.infer<typeof worktreeRecipeSchema>;

export const worktreeRecipeListSchema = z
  .array(worktreeRecipeSchema)
  .max(worktreeRecipeLimits.recipes);

export const saveWorktreeRecipeSchema = z.strictObject({
  ...contentShape,
  id: z.uuid().nullable(),
  name: recipeIdentityShape.name,
  directory: directorySchema,
});
export type SaveWorktreeRecipeInput = z.infer<typeof saveWorktreeRecipeSchema>;

export const deleteWorktreeRecipeSchema = z.strictObject({ id: z.uuid() });
export type DeleteWorktreeRecipeInput = z.infer<
  typeof deleteWorktreeRecipeSchema
>;

export const matchWorktreeRecipeSchema = z.strictObject({
  directory: directorySchema,
});
export type MatchWorktreeRecipeInput = z.infer<
  typeof matchWorktreeRecipeSchema
>;

const repositoryScriptSchema = z.strictObject({
  sha256: hashSchema,
  approved: z.boolean(),
});

export const worktreeRecipeMatchSchema = z.strictObject({
  repository: worktreeRecipeRepositorySchema,
  directory: directorySchema,
  recipe: worktreeRecipeSchema.nullable(),
  repositoryScript: repositoryScriptSchema.nullable(),
  repositoryIncludes: z.boolean(),
});
export type WorktreeRecipeMatch = z.infer<typeof worktreeRecipeMatchSchema>;

export const worktreeRecipeStepSchema = z.strictObject({
  kind: z.enum(['repository-script', 'copy', 'setup', 'cleanup']),
  status: z.enum([
    'pending',
    'running',
    'completed',
    'failed',
    'timed-out',
    'stopped',
    'skipped',
  ]),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  exitCode: z.number().int().nullable(),
  output: z.string().max(worktreeRecipeLimits.output),
  truncated: z.boolean(),
});
export type WorktreeRecipeStep = z.infer<typeof worktreeRecipeStepSchema>;

export const worktreeRecipeResourcesSchema = z.strictObject({
  ports: z.array(portSchema).max(worktreeRecipeLimits.ports),
  tag: z.string().min(1).max(64).nullable(),
  tempDirectory: directorySchema.nullable(),
});
export type WorktreeRecipeResources = z.infer<
  typeof worktreeRecipeResourcesSchema
>;

export const worktreeRecipeSnapshotSchema = z.strictObject({
  ...recipeIdentityShape,
  ...contentShape,
});
export type WorktreeRecipeSnapshot = z.infer<
  typeof worktreeRecipeSnapshotSchema
>;

export const worktreeRecipeRunSchema = z.strictObject({
  sessionId: z.uuid().nullable(),
  directory: directorySchema,
  recipe: worktreeRecipeSnapshotSchema,
  repositoryScript: repositoryScriptSchema.nullable(),
  status: z.enum([
    'needs-approval',
    'running',
    'ready',
    'failed',
    'stopped',
    'skipped',
    'interrupted',
  ]),
  resources: worktreeRecipeResourcesSchema.nullable(),
  released: z.boolean(),
  copied: z
    .strictObject({
      copied: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      incomplete: z.boolean(),
    })
    .nullable(),
  steps: z.array(worktreeRecipeStepSchema).max(4),
  error: z.string().max(worktreeRecipeLimits.error).nullable(),
  updatedAt: z.iso.datetime(),
});
export type WorktreeRecipeRun = z.infer<typeof worktreeRecipeRunSchema>;

export const startWorktreeRecipeTrialSchema = z.strictObject({
  id: z.uuid(),
  directory: directorySchema,
});
export type StartWorktreeRecipeTrialInput = z.infer<
  typeof startWorktreeRecipeTrialSchema
>;

export const worktreeRecipeTrialRefSchema = z.strictObject({ id: z.uuid() });
export type WorktreeRecipeTrialRefInput = z.infer<
  typeof worktreeRecipeTrialRefSchema
>;

export const readSessionWorktreeRecipeSchema = z.strictObject({
  sessionId: z.uuid(),
});
export type ReadSessionWorktreeRecipeInput = z.infer<
  typeof readSessionWorktreeRecipeSchema
>;

export const decideSessionWorktreeRecipeSchema = z.strictObject({
  sessionId: z.uuid(),
  decision: z.enum(['approve', 'skip', 'stop']),
  sha256: hashSchema,
});
export type DecideSessionWorktreeRecipeInput = z.infer<
  typeof decideSessionWorktreeRecipeSchema
>;

export const worktreeRecipeEnvironment = (
  resources: WorktreeRecipeResources,
): Record<string, string> => ({
  ...Object.fromEntries(
    resources.ports.map((port, index) => [
      `NESVO_PORT_${index + 1}`,
      String(port),
    ]),
  ),
  ...(resources.tag ? { NESVO_RESOURCE_TAG: resources.tag } : {}),
  ...(resources.tempDirectory
    ? { NESVO_TEMP_DIR: resources.tempDirectory }
    : {}),
});
