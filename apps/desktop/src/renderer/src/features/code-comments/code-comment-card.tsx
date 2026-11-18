import type { CodeComment } from '@nesvo/contracts';
import { FileCode2 } from 'lucide-react';
import { CodeBlock } from '@/shared/ui/code-block';
import { Disclosure } from '@/shared/ui/disclosure';
import { Hint } from '@/shared/ui/tooltip';
import { commentFullLocation, commentLocation } from './location';

function CodeCommentCard({ comment }: { comment: CodeComment }) {
  return (
    <li
      data-slot="code-comment-card"
      className="min-w-0 rounded-surface border bg-card px-2.5 py-2"
    >
      <Hint label={commentFullLocation(comment)}>
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground">
          <FileCode2 aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{commentLocation(comment)}</span>
        </p>
      </Hint>
      <p className="mt-1 text-ui leading-relaxed break-words whitespace-pre-wrap">
        {comment.body}
      </p>
      {comment.snippet && (
        <Disclosure
          title="Diff lines"
          className="-mx-2 mt-1"
          contentClassName="pl-2"
        >
          <CodeBlock
            aria-label={`Diff lines for ${commentFullLocation(comment)}`}
            code={comment.snippet}
            maxHeightClassName="max-h-60"
          />
        </Disclosure>
      )}
    </li>
  );
}

export function CodeCommentCards({
  comments,
}: {
  comments: readonly CodeComment[];
}) {
  return (
    <ul
      aria-label="Code comments"
      className="flex w-full max-w-[85%] flex-col gap-1.5 self-end"
    >
      {comments.map(comment => (
        <CodeCommentCard key={comment.id} comment={comment} />
      ))}
    </ul>
  );
}
