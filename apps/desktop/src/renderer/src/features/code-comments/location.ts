import type { CodeComment } from '@nesvo/contracts';

type CommentRange = Pick<
  CodeComment,
  'path' | 'side' | 'startLine' | 'endLine'
>;

export const fileNameOf = (path: string) => path.split('/').at(-1) ?? path;

export const commentLines = ({ startLine, endLine, side }: CommentRange) => {
  const lines =
    startLine === endLine ? `${startLine}` : `${startLine}–${endLine}`;
  return side === 'old' ? `${lines} (removed)` : lines;
};

export const commentLocation = (comment: CommentRange) =>
  `${fileNameOf(comment.path)}:${commentLines(comment)}`;

export const commentFullLocation = (comment: CommentRange) =>
  `${comment.path}:${commentLines(comment)}`;
