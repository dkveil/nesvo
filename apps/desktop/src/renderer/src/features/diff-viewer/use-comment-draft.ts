import { useState } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { CodeComment } from '@nesvo/contracts';
import { snippetOf, type DiffLineRange } from './line-range';

export type CommentDraft = {
  path: string;
  range: DiffLineRange;
  body: string;
};

export const useCommentDraft = () => {
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  return {
    draft,
    open: (path: string, range: DiffLineRange) =>
      setDraft(previous => ({
        path,
        range,
        body: previous?.path === path ? previous.body : '',
      })),
    edit: (body: string) =>
      setDraft(previous => previous && { ...previous, body }),
    close: () => setDraft(null),
  };
};

export const codeCommentOf = (
  draft: CommentDraft,
  diff: FileDiffMetadata,
): Omit<CodeComment, 'offset'> => ({
  id: crypto.randomUUID(),
  path: draft.path,
  side: draft.range.side,
  startLine: draft.range.startLine,
  endLine: draft.range.endLine,
  body: draft.body.trim(),
  snippet: snippetOf(diff, draft.range),
});
