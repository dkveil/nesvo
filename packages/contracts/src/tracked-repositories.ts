import { z } from 'zod';
import {
  githubRepositorySchema,
  pullRequestListScopeSchema,
  pullRequestSummarySchema,
} from './pull-requests';

export const trackedRepositoryLimits = {
  repositories: 30,
  itemsPerRepository: 30,
  suggestions: 20,
  inputLength: 300,
} as const;

const REPOSITORY_URL_PATTERN =
  /^(?:https?:\/\/(?:www\.)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/i;

export function parseGitHubRepository(text: string): string | null {
  const value = text.trim();
  const match = REPOSITORY_URL_PATTERN.exec(value);
  const candidate = match ? `${match[1]}/${match[2]}` : value;
  const parsed = githubRepositorySchema.safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data.endsWith('/.') || parsed.data.endsWith('/..')
    ? null
    : parsed.data;
}

const directorySchema = z
  .string()
  .trim()
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]*$/);

export const trackedRepositorySchema = z.strictObject({
  id: z.uuid(),
  repository: githubRepositorySchema,
  directory: directorySchema.min(1).nullable(),
  addedAt: z.iso.datetime(),
});
export type TrackedRepository = z.infer<typeof trackedRepositorySchema>;

export const trackedRepositoryListSchema = z
  .array(trackedRepositorySchema)
  .max(trackedRepositoryLimits.repositories);

export const addTrackedRepositorySchema = z.strictObject({
  repository: z
    .string()
    .trim()
    .min(1)
    .max(trackedRepositoryLimits.inputLength)
    .refine(value => parseGitHubRepository(value) !== null, {
      message: 'Use owner/name or a GitHub repository link.',
    }),
  directory: directorySchema.optional(),
});
export type AddTrackedRepositoryInput = z.input<
  typeof addTrackedRepositorySchema
>;

export const removeTrackedRepositorySchema = z.strictObject({ id: z.uuid() });
export type RemoveTrackedRepositoryInput = z.infer<
  typeof removeTrackedRepositorySchema
>;

export const reorderTrackedRepositoriesSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .max(trackedRepositoryLimits.repositories)
    .refine(ids => new Set(ids).size === ids.length, {
      message: 'List each repository once.',
    }),
});
export type ReorderTrackedRepositoriesInput = z.infer<
  typeof reorderTrackedRepositoriesSchema
>;

export const trackedRepositorySuggestionSchema = z.strictObject({
  repository: githubRepositorySchema,
  directory: directorySchema.min(1).nullable(),
  source: z.enum(['session-folder', 'pull-request']),
});
export type TrackedRepositorySuggestion = z.infer<
  typeof trackedRepositorySuggestionSchema
>;

export const trackedRepositorySuggestionListSchema = z
  .array(trackedRepositorySuggestionSchema)
  .max(trackedRepositoryLimits.suggestions);

export const listTrackedPullRequestsSchema = z.strictObject({
  scope: pullRequestListScopeSchema.default('open'),
  query: z.string().trim().max(205).optional(),
});
export type ListTrackedPullRequestsInput = z.input<
  typeof listTrackedPullRequestsSchema
>;

export const trackedPullRequestListSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    trackedId: z.uuid(),
    repository: githubRepositorySchema,
    items: z
      .array(pullRequestSummarySchema)
      .max(trackedRepositoryLimits.itemsPerRepository),
    truncated: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('error'),
    trackedId: z.uuid(),
    repository: githubRepositorySchema,
    code: z.enum(['invalid-request', 'unavailable', 'busy', 'not-found']),
    message: z.string().max(1000),
  }),
]);
export type TrackedPullRequestList = z.infer<
  typeof trackedPullRequestListSchema
>;

export const trackedPullRequestListsSchema = z
  .array(trackedPullRequestListSchema)
  .max(trackedRepositoryLimits.repositories);
