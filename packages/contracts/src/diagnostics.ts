import { z } from 'zod';

export const HOST_CONTRACT_REVISION = 1;

export const MAX_RENDERER_ERROR_REPORT_BYTES = 48 * 1024;

export const rendererErrorReportSchema = z.strictObject({
  kind: z.enum(['render', 'unhandled', 'dropped-event']),
  message: z.string().max(2000),
  stack: z.string().max(16_000).optional(),
  componentStack: z.string().max(16_000).optional(),
});
export type RendererErrorReport = z.infer<typeof rendererErrorReportSchema>;
