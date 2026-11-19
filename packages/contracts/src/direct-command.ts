import { z } from 'zod';

const path = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
export const directCommandSchema = z.strictObject({
  executable: path,
  argv: z
    .array(
      z
        .string()
        .max(4096)
        .regex(/^[^\u0000-\u001f\u007f]*$/u),
    )
    .max(64),
  files: z.array(path).max(16).default([]),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(256 * 1024)
    .default(64 * 1024),
});
export type DirectCommand = z.infer<typeof directCommandSchema>;
