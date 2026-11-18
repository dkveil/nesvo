import { z } from 'zod';
import { conversationIdentitySchema } from './conversation-import';
import { searchSnippetSchema } from './history-search';

export const transcriptSearchInputSchema = z.strictObject({
  query: z.string().max(200).trim().min(1),
  limit: z.number().int().min(1).max(50).default(20),
});

export const transcriptSearchResultSchema = conversationIdentitySchema.extend({
  directory: z.string().min(1).max(4096),
  title: z.string().min(1).max(100),
  lastActivityAt: z.iso.datetime(),
  snippet: searchSnippetSchema,
});

export const transcriptSearchPageSchema = z.strictObject({
  results: z.array(transcriptSearchResultSchema).max(50),
  indexedTranscripts: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type TranscriptSearchInput = z.input<typeof transcriptSearchInputSchema>;
export type TranscriptSearchResult = z.infer<
  typeof transcriptSearchResultSchema
>;
export type TranscriptSearchPage = z.infer<typeof transcriptSearchPageSchema>;
