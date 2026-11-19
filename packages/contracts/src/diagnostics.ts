import { z } from 'zod';

export const HOST_CONTRACT_REVISION = 7;

export const MAX_RENDERER_ERROR_REPORT_BYTES = 48 * 1024;

export const rendererErrorReportSchema = z.strictObject({
  kind: z.enum(['render', 'unhandled', 'dropped-event']),
  message: z.string().max(2000),
  stack: z.string().max(16_000).optional(),
  componentStack: z.string().max(16_000).optional(),
});
export type RendererErrorReport = z.infer<typeof rendererErrorReportSchema>;

export const databaseBackupSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  bytes: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type DatabaseBackup = z.infer<typeof databaseBackupSchema>;

export const aboutInfoSchema = z.strictObject({
  version: z.string().min(1).max(100),
  electron: z.string().max(100),
  node: z.string().max(100),
  chrome: z.string().max(100),
  platform: z.string().max(100),
  arch: z.string().max(100),
  osRelease: z.string().max(200),
  packaged: z.boolean(),
  dataDirectory: z.string().min(1).max(4096),
  hostDirectory: z.string().min(1).max(4096),
  logsDirectory: z.string().min(1).max(4096),
});
export type AboutInfo = z.infer<typeof aboutInfoSchema>;

export const MAX_SAVED_TEXT_FILE_BYTES = 16 * 1024 * 1024;

export const saveTextFileSchema = z.strictObject({
  defaultName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\/:*?"<>|\u0000-\u001f]+\.md$/),
  content: z.string().max(MAX_SAVED_TEXT_FILE_BYTES),
});
export type SaveTextFileInput = z.infer<typeof saveTextFileSchema>;

export const savedTextFileSchema = z.discriminatedUnion('saved', [
  z.strictObject({ saved: z.literal(true), path: z.string().min(1).max(4096) }),
  z.strictObject({ saved: z.literal(false) }),
]);
export type SavedTextFile = z.infer<typeof savedTextFileSchema>;
