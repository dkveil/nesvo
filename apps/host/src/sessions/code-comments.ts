import type { CodeComment, MessageAttachment } from '@nesvo/contracts';

const lineLabel = (comment: CodeComment) =>
  comment.startLine === comment.endLine
    ? `${comment.startLine}`
    : `${comment.startLine}-${comment.endLine}`;

export const codeCommentBlock = (comment: CodeComment) => {
  const snippet = comment.snippet.replace(/\n+$/, '');
  return [
    `<code-comment path=${JSON.stringify(comment.path)} side="${comment.side}" lines="${lineLabel(comment)}">`,
    comment.body,
    ...(snippet ? ['```diff', snippet, '```'] : []),
    '</code-comment>',
  ].join('\n');
};

const placedAt = (comment: CodeComment, length: number) =>
  Math.min(Math.max(comment.offset ?? length, 0), length);

export const withCodeComments = (
  text: string,
  comments: readonly CodeComment[] | undefined,
  attachments: readonly MessageAttachment[] | undefined,
): { text: string; attachments: MessageAttachment[] | undefined } => {
  if (!comments?.length)
    return { text, attachments: attachments ? [...attachments] : undefined };
  const ordered = comments
    .map((comment, index) => ({
      comment,
      index,
      at: placedAt(comment, text.length),
    }))
    .sort((left, right) => left.at - right.at || left.index - right.index);
  let composed = '';
  let cursor = 0;
  const shifts: { at: number; by: number }[] = [];
  for (const { comment, at } of ordered) {
    composed += text.slice(cursor, at);
    const block = `\n${codeCommentBlock(comment)}\n`;
    shifts.push({ at, by: block.length });
    composed += block;
    cursor = at;
  }
  composed += text.slice(cursor);
  return {
    text: composed,
    attachments: attachments?.map(attachment =>
      attachment.offset == null
        ? attachment
        : {
            ...attachment,
            offset:
              attachment.offset +
              shifts
                .filter(shift => shift.at < attachment.offset!)
                .reduce((sum, shift) => sum + shift.by, 0),
          },
    ),
  };
};

const commentKey = (comment: CodeComment) =>
  `${comment.id}@${comment.offset ?? ''}`;

export const sameCodeComments = (
  left: readonly CodeComment[] | undefined,
  right: readonly CodeComment[] | undefined,
) =>
  (left ?? []).map(commentKey).join() === (right ?? []).map(commentKey).join();
