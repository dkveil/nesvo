import { z } from 'zod';
import { providerSchema, sessionMessageSchema } from './sessions';

export const historySearchInputSchema = z.strictObject({
  query: z.string().max(200).trim().min(1),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .optional(),
});

const snippetSchema = z
  .strictObject({
    text: z.string().max(360),
    ranges: z
      .array(
        z.strictObject({
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
        }),
      )
      .max(180),
  })
  .refine(({ text, ranges }) =>
    ranges.every(
      ({ start, end }, index) =>
        start < end &&
        end <= text.length &&
        start >= (ranges[index - 1]?.end ?? 0),
    ),
  );

export const historySearchResultSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid().nullable(),
  title: z.string(),
  directory: z.string(),
  provider: providerSchema,
  role: z.union([sessionMessageSchema.shape.author, z.literal('title')]),
  snippet: snippetSchema,
  createdAt: z.iso.datetime(),
});

export const historySearchPageSchema = z.strictObject({
  results: z.array(historySearchResultSchema).max(100),
  truncated: z.boolean(),
  nextCursor: historySearchInputSchema.shape.cursor.unwrap().nullable(),
});

export type HistorySearchInput = z.input<typeof historySearchInputSchema>;
export type HistorySearchResult = z.infer<typeof historySearchResultSchema>;
export type HistorySearchPage = z.infer<typeof historySearchPageSchema>;
