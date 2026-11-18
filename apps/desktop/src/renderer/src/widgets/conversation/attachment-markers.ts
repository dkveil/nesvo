import type { MessageAttachment } from '@nesvo/contracts';

export const ATTACHMENT_MARKER_PREFIX = '#nesvo-attachment-';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ESCAPING_CHARACTERS = new Set(['!', '\\']);
const ZERO_WIDTH_SPACE = '\u200b';

const insideCode = (body: string, offset: number) => {
  const before = body.slice(0, offset);
  const lines = before.split('\n');
  const fences = lines.filter(line => FENCE.test(line)).length;
  if (fences % 2 === 1) return true;
  const currentLine = lines.at(-1) ?? '';
  return (currentLine.match(/`/g)?.length ?? 0) % 2 === 1;
};

export const attachmentIndexOf = (href: string | undefined) => {
  if (!href?.startsWith(ATTACHMENT_MARKER_PREFIX)) return null;
  const index = Number(href.slice(ATTACHMENT_MARKER_PREFIX.length));
  return Number.isInteger(index) ? index : null;
};

export const hasPlacedAttachments = (
  attachments: readonly MessageAttachment[] | undefined,
) => !!attachments?.some(attachment => attachment.offset != null);

export const withAttachmentMarkers = (
  body: string,
  attachments: readonly MessageAttachment[],
) => {
  const placed = attachments
    .flatMap((attachment, index) =>
      attachment.offset == null
        ? []
        : [{ index, offset: Math.min(attachment.offset, body.length) }],
    )
    .filter(({ offset }) => !insideCode(body, offset))
    .sort(
      (left, right) => left.offset - right.offset || left.index - right.index,
    );
  let marked = '';
  let cursor = 0;
  for (const { index, offset } of placed) {
    marked += body.slice(cursor, offset);
    if (ESCAPING_CHARACTERS.has(marked.at(-1) ?? ''))
      marked += ZERO_WIDTH_SPACE;
    marked += `[](${ATTACHMENT_MARKER_PREFIX}${index})`;
    cursor = offset;
  }
  return marked + body.slice(cursor);
};
