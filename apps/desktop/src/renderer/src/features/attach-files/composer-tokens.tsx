import type { ComposerEditorToken } from '@/shared/ui/composer-editor';
import { ComposerAttachmentToken } from './inline-attachment';
import type { ComposerAttachment } from './use-composer-attachments';

export const composerTokens = (
  items: readonly ComposerAttachment[],
): ComposerEditorToken[] =>
  items.flatMap(item =>
    item.offset == null
      ? []
      : [
          {
            id: item.localId,
            offset: item.offset,
            content: <ComposerAttachmentToken item={item} />,
          },
        ],
  );
