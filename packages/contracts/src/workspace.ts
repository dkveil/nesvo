import { z } from 'zod';

export const workspaceLimits = {
  entries: 500,
  matches: 200,
  visited: 5000,
  depth: 32,
  milliseconds: 3000,
  previewBytes: 256 * 1024,
} as const;

export const listWorkspaceDirectorySchema = z.strictObject({
  sessionId: z.uuid(),
  path: z.string().max(4096),
});
export const searchWorkspaceFilesSchema = listWorkspaceDirectorySchema.extend({
  query: z.string().trim().min(1).max(100),
});
export const readWorkspaceFileSchema = listWorkspaceDirectorySchema.extend({
  path: z.string().min(1).max(4096),
});
export const workspaceEntrySchema = z.strictObject({
  name: z.string().max(1024),
  path: z.string().max(4096),
  kind: z.enum(['directory', 'file']),
  size: z.number().int().nonnegative().nullable(),
});
export const workspaceDirectorySchema = z.strictObject({
  sessionId: z.uuid(),
  path: z.string().max(4096),
  entries: z.array(workspaceEntrySchema).max(workspaceLimits.entries),
  truncated: z.boolean(),
  detail: z.string().nullable(),
});
export const workspaceSearchSchema = z.strictObject({
  sessionId: z.uuid(),
  path: z.string().max(4096),
  query: z.string(),
  matches: z.array(workspaceEntrySchema).max(workspaceLimits.matches),
  truncated: z.boolean(),
  detail: z.string().nullable(),
});
export const workspaceFileSchema = z.strictObject({
  sessionId: z.uuid(),
  path: z.string().max(4096),
  status: z.enum(['text', 'binary', 'too-large']),
  text: z.string().max(workspaceLimits.previewBytes).nullable(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  detail: z.string().nullable(),
});

export type ListWorkspaceDirectoryInput = z.infer<
  typeof listWorkspaceDirectorySchema
>;
export type SearchWorkspaceFilesInput = z.infer<
  typeof searchWorkspaceFilesSchema
>;
export type ReadWorkspaceFileInput = z.infer<typeof readWorkspaceFileSchema>;
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;
export type WorkspaceSearch = z.infer<typeof workspaceSearchSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const readGitBranchSchema = z.strictObject({
  directory: z.string().trim().max(4096),
});
export const gitBranchSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('branch'),
    name: z.string().min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal('detached'),
    sha: z.string().regex(/^[0-9a-f]{7}$/),
  }),
  z.strictObject({ kind: z.literal('none') }),
]);

export type ReadGitBranchInput = z.infer<typeof readGitBranchSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
