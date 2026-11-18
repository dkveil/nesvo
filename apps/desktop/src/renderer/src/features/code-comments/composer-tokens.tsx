import type { ComposerEditorToken } from '@/shared/ui/composer-editor';
import { CodeCommentToken } from './code-comment-token';
import type { PendingCodeComment } from './store';

export const codeCommentTokens = (
  items: readonly PendingCodeComment[],
  textLength: number,
): ComposerEditorToken[] =>
  items.map(item => ({
    id: item.comment.id,
    offset: item.offset ?? textLength,
    content: <CodeCommentToken item={item} />,
  }));
