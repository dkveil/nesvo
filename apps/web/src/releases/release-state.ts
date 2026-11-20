import { z } from 'zod';

import { DOWNLOAD_TARGET_IDS } from './download-targets';

export const releaseDownloadSchema = z.object({
  target: z.enum(DOWNLOAD_TARGET_IDS),
  fileName: z.string(),
  sizeBytes: z.number().nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  isPublished: z.boolean(),
});

export const publishedReleaseSchema = z.object({
  version: z.string(),
  tagName: z.string(),
  isPrerelease: z.boolean().default(false),
  publishedAt: z.string().nullable(),
  notesUrl: z.string(),
  checksumsUrl: z.string().nullable(),
  downloads: z.array(releaseDownloadSchema),
});

export const releaseStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('published'),
    release: publishedReleaseSchema,
    secondaryPreview: publishedReleaseSchema.nullable().default(null),
  }),
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('unavailable') }),
]);

export type ReleaseDownload = z.infer<typeof releaseDownloadSchema>;
export type PublishedRelease = z.infer<typeof publishedReleaseSchema>;
export type ReleaseState = z.infer<typeof releaseStateSchema>;

export const downloadReleaseFor = (
  state: ReleaseState,
  channel: string | null,
): PublishedRelease | null => {
  if (state.status !== 'published') return null;
  if (channel !== 'preview' || state.release.isPrerelease) return state.release;
  return state.secondaryPreview;
};
