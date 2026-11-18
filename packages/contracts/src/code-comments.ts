import { z } from 'zod';
import { attachmentLimits } from './attachments';

export const codeCommentLimits = {
  perMessage: 20,
  bodyLength: 4000,
  snippetLength: 8000,
  pathLength: 4096,
  line: 10_000_000,
} as const;

export const codeCommentSideSchema = z.enum(['old', 'new']);
const lineSchema = z.number().int().positive().max(codeCommentLimits.line);

export const codeCommentSchema = z
  .strictObject({
    id: z.uuid(),
    path: z.string().trim().min(1).max(codeCommentLimits.pathLength),
    side: codeCommentSideSchema,
    startLine: lineSchema,
    endLine: lineSchema,
    body: z.string().trim().min(1).max(codeCommentLimits.bodyLength),
    snippet: z.string().max(codeCommentLimits.snippetLength),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(attachmentLimits.textOffset)
      .optional(),
  })
  .refine(comment => comment.startLine <= comment.endLine, {
    message: 'The first line must not follow the last line.',
    path: ['endLine'],
  });

export const messageCodeCommentsSchema = z
  .array(codeCommentSchema)
  .min(1)
  .max(codeCommentLimits.perMessage)
  .refine(
    comments =>
      new Set(comments.map(comment => comment.id)).size === comments.length,
    { message: 'Add each code comment once.' },
  );

export type CodeCommentSide = z.infer<typeof codeCommentSideSchema>;
export type CodeComment = z.infer<typeof codeCommentSchema>;
