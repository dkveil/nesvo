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
  publishedAt: z.string().nullable(),
  notesUrl: z.string(),
  checksumsUrl: z.string().nullable(),
  downloads: z.array(releaseDownloadSchema),
});

export const releaseStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('published'), release: publishedReleaseSchema }),
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('unavailable') }),
]);

export type ReleaseDownload = z.infer<typeof releaseDownloadSchema>;
export type PublishedRelease = z.infer<typeof publishedReleaseSchema>;
export type ReleaseState = z.infer<typeof releaseStateSchema>;
