import { z } from 'zod';

export const attachmentMediaTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export const attachmentLimits = {
  bytes: 5 * 1024 * 1024,
  perMessage: 5,
  chunkBytes: 512 * 1024,
  textOffset: 32000,
} as const;

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

export const attachmentMediaTypeSchema = z.enum(attachmentMediaTypes);
export const attachmentIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const messageAttachmentSchema = z.strictObject({
  id: attachmentIdSchema,
  mediaType: attachmentMediaTypeSchema,
  size: z.number().int().positive().max(attachmentLimits.bytes),
  name: z.string().trim().min(1).max(255),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(attachmentLimits.textOffset)
    .optional(),
});
export const messageAttachmentsSchema = z
  .array(messageAttachmentSchema)
  .min(1)
  .max(attachmentLimits.perMessage)
  .refine(
    attachments =>
      new Set(attachments.map(attachment => attachment.id)).size ===
      attachments.length,
    { message: 'Attach each image once.' },
  );
export const stageAttachmentSchema = z.strictObject({
  uploadId: z.uuid(),
  name: z.string().trim().min(1).max(255),
  offset: z.number().int().nonnegative().max(attachmentLimits.bytes),
  data: z.base64().max(base64Length(attachmentLimits.chunkBytes)),
  final: z.boolean(),
});
export const attachmentUploadSchema = z.strictObject({
  received: z.number().int().nonnegative().max(attachmentLimits.bytes),
  attachment: messageAttachmentSchema.nullable(),
});
export const readAttachmentSchema = z.strictObject({
  id: attachmentIdSchema,
});
export const attachmentContentSchema = z.strictObject({
  id: attachmentIdSchema,
  mediaType: attachmentMediaTypeSchema,
  data: z.base64().max(base64Length(attachmentLimits.bytes)),
});
export const imageInputSupportSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported') }),
  z.strictObject({ status: z.literal('per-model') }),
  z.strictObject({
    status: z.literal('unsupported'),
    reason: z.string().min(1).max(500),
  }),
]);

export type AttachmentMediaType = z.infer<typeof attachmentMediaTypeSchema>;
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export type StageAttachmentInput = z.infer<typeof stageAttachmentSchema>;
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;
export type ReadAttachmentInput = z.infer<typeof readAttachmentSchema>;
export type AttachmentContent = z.infer<typeof attachmentContentSchema>;
export type ImageInputSupport = z.infer<typeof imageInputSupportSchema>;
