import { z } from 'zod';

export const defaultSessionFolderSchema = z
  .string()
  .min(1)
  .max(4096)
  .nullable();

export const setDefaultSessionFolderSchema = z.strictObject({
  directory: z
    .string()
    .trim()
    .max(4096)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
    .nullable(),
});

export type DefaultSessionFolder = z.infer<typeof defaultSessionFolderSchema>;
export type SetDefaultSessionFolderInput = z.infer<
  typeof setDefaultSessionFolderSchema
>;
