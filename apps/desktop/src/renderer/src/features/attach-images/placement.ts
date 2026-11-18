import type { MessageAttachment } from '@nesvo/contracts';

export const placeInText = (
  attachments: readonly MessageAttachment[],
  leadingCharacters: number,
  textLength: number,
): MessageAttachment[] =>
  attachments.map(attachment =>
    attachment.offset == null
      ? attachment
      : {
          ...attachment,
          offset: Math.min(
            Math.max(attachment.offset - leadingCharacters, 0),
            textLength,
          ),
        },
  );

export const withoutPlacement = ({
  id,
  mediaType,
  size,
  name,
}: MessageAttachment): MessageAttachment => ({ id, mediaType, size, name });
