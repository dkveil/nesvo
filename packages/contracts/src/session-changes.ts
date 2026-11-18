import { z } from 'zod';

export const sessionChangeLimits = {
  files: 1000,
  patchBytes: 512 * 1024,
  pathLength: 4096,
  baseLength: 255,
} as const;

export const sessionChangeScopeSchema = z.enum(['uncommitted', 'branch']);

const changePathSchema = z
  .string()
  .min(1)
  .max(sessionChangeLimits.pathLength)
  .refine(
    path =>
      !path.startsWith('/') &&
      !path.startsWith('-') &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes('\\') &&
      !path.includes('\u0000') &&
      !path.split('/').some(part => part === '..' || part === '.' || !part),
    { message: 'Use a relative path inside the session folder.' },
  );

export const readSessionChangesSchema = z.strictObject({
  sessionId: z.uuid(),
});

export const readSessionChangePatchSchema = z.strictObject({
  sessionId: z.uuid(),
  scope: sessionChangeScopeSchema,
  path: changePathSchema,
  previousPath: changePathSchema.nullable().default(null),
});

const countSchema = z.number().int().nonnegative();

export const sessionChangedFileSchema = z.strictObject({
  path: z.string().min(1).max(sessionChangeLimits.pathLength),
  previousPath: z.string().max(sessionChangeLimits.pathLength).nullable(),
  status: z.enum(['added', 'modified', 'removed', 'renamed', 'untracked']),
  additions: countSchema.nullable(),
  deletions: countSchema.nullable(),
});

export const sessionChangeSetSchema = z.strictObject({
  status: z.enum(['available', 'unavailable']),
  base: z.string().max(sessionChangeLimits.baseLength).nullable(),
  files: z.array(sessionChangedFileSchema).max(sessionChangeLimits.files),
  additions: countSchema,
  deletions: countSchema,
  truncated: z.boolean(),
  detail: z.string().max(500).nullable(),
});

export const sessionChangesSchema = z.strictObject({
  sessionId: z.uuid(),
  readAt: z.iso.datetime(),
  uncommitted: sessionChangeSetSchema,
  branch: sessionChangeSetSchema,
});

export const sessionChangePatchSchema = z.strictObject({
  sessionId: z.uuid(),
  scope: sessionChangeScopeSchema,
  path: z.string().min(1).max(sessionChangeLimits.pathLength),
  status: z.enum(['text', 'binary', 'unchanged']),
  patch: z.string().max(sessionChangeLimits.patchBytes),
  truncated: z.boolean(),
  detail: z.string().max(500).nullable(),
});

export type SessionChangeScope = z.infer<typeof sessionChangeScopeSchema>;
export type ReadSessionChangesInput = z.infer<typeof readSessionChangesSchema>;
export type ReadSessionChangePatchInput = z.input<
  typeof readSessionChangePatchSchema
>;
export type SessionChangedFile = z.infer<typeof sessionChangedFileSchema>;
export type SessionChangeSet = z.infer<typeof sessionChangeSetSchema>;
export type SessionChanges = z.infer<typeof sessionChangesSchema>;
export type SessionChangePatch = z.infer<typeof sessionChangePatchSchema>;
