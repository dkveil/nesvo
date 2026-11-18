import { z } from 'zod';

const MEGABYTE = 1024 * 1024;

export const imageMediaTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export const pdfMediaType = 'application/pdf';
export const fileMediaType = 'application/octet-stream';
export const attachmentMediaTypes = [
  ...imageMediaTypes,
  pdfMediaType,
  fileMediaType,
] as const;
export const attachmentKinds = ['image', 'pdf', 'file'] as const;
export const attachmentLimits = {
  imageBytes: 5 * MEGABYTE,
  pdfBytes: 20 * MEGABYTE,
  fileBytes: 50 * MEGABYTE,
  maxBytes: 50 * MEGABYTE,
  perMessage: 10,
  chunkBytes: 512 * 1024,
  textOffset: 32000,
} as const;

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

export type AttachmentKind = (typeof attachmentKinds)[number];

export const attachmentKind = (mediaType: string): AttachmentKind =>
  (imageMediaTypes as readonly string[]).includes(mediaType)
    ? 'image'
    : mediaType === pdfMediaType
      ? 'pdf'
      : 'file';

export const attachmentByteLimit = (kind: AttachmentKind) =>
  kind === 'image'
    ? attachmentLimits.imageBytes
    : kind === 'pdf'
      ? attachmentLimits.pdfBytes
      : attachmentLimits.fileBytes;

const KIND_LABELS = {
  image: 'Images',
  pdf: 'PDF files',
  file: 'Files',
} as const satisfies Record<AttachmentKind, string>;

export const attachmentLimitMessage = (kind: AttachmentKind) =>
  `${KIND_LABELS[kind]} must be ${attachmentByteLimit(kind) / MEGABYTE} MB or smaller.`;

const EXECUTABLE_EXTENSIONS = new Set([
  'app',
  'appref-ms',
  'bat',
  'cmd',
  'com',
  'command',
  'cpl',
  'desktop',
  'exe',
  'hta',
  'jar',
  'js',
  'jse',
  'lnk',
  'msc',
  'msi',
  'msp',
  'pif',
  'pkg',
  'ps1',
  'psm1',
  'reg',
  'scr',
  'sh',
  'url',
  'vb',
  'vbe',
  'vbs',
  'webloc',
  'workflow',
  'ws',
  'wsf',
  'wsh',
]);

export const opensAsProgram = (name: string) =>
  EXECUTABLE_EXTENSIONS.has(name.split('.').at(-1)?.toLowerCase() ?? '');

export const attachmentMediaTypeSchema = z.enum(attachmentMediaTypes);
export const imageMediaTypeSchema = z.enum(imageMediaTypes);
export const attachmentIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const messageAttachmentSchema = z
  .strictObject({
    id: attachmentIdSchema,
    mediaType: attachmentMediaTypeSchema,
    size: z.number().int().positive().max(attachmentLimits.maxBytes),
    name: z.string().trim().min(1).max(255),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(attachmentLimits.textOffset)
      .optional(),
  })
  .refine(
    attachment =>
      attachment.size <=
      attachmentByteLimit(attachmentKind(attachment.mediaType)),
    { message: 'The attachment is larger than its type allows.' },
  );
export const messageAttachmentsSchema = z
  .array(messageAttachmentSchema)
  .min(1)
  .max(attachmentLimits.perMessage)
  .refine(
    attachments =>
      new Set(attachments.map(attachment => attachment.id)).size ===
      attachments.length,
    { message: 'Attach each file once.' },
  );
export const stageAttachmentSchema = z.strictObject({
  uploadId: z.uuid(),
  name: z.string().trim().min(1).max(255),
  offset: z.number().int().nonnegative().max(attachmentLimits.maxBytes),
  data: z.base64().max(base64Length(attachmentLimits.chunkBytes)),
  final: z.boolean(),
});
export const attachmentUploadSchema = z.strictObject({
  received: z.number().int().nonnegative().max(attachmentLimits.maxBytes),
  attachment: messageAttachmentSchema.nullable(),
});
export const readAttachmentSchema = z.strictObject({
  id: attachmentIdSchema,
});
export const attachmentContentSchema = z.strictObject({
  id: attachmentIdSchema,
  mediaType: imageMediaTypeSchema,
  data: z.base64().max(base64Length(attachmentLimits.imageBytes)),
});
export const locateAttachmentSchema = z.strictObject({
  sessionId: z.uuid(),
  id: attachmentIdSchema,
});
export const attachmentLocationSchema = z.strictObject({
  id: attachmentIdSchema,
  name: z.string().trim().min(1).max(255),
  path: z.string().min(1).max(4096),
});
export const attachmentActions = ['open', 'reveal'] as const;
export const openAttachmentSchema = locateAttachmentSchema.extend({
  action: z.enum(attachmentActions),
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
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export type StageAttachmentInput = z.infer<typeof stageAttachmentSchema>;
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;
export type ReadAttachmentInput = z.infer<typeof readAttachmentSchema>;
export type AttachmentContent = z.infer<typeof attachmentContentSchema>;
export type LocateAttachmentInput = z.infer<typeof locateAttachmentSchema>;
export type AttachmentLocation = z.infer<typeof attachmentLocationSchema>;
export type OpenAttachmentInput = z.infer<typeof openAttachmentSchema>;
export type ImageInputSupport = z.infer<typeof imageInputSupportSchema>;
