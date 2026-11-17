import { useState } from 'react';
import type { PullRequestThread } from '@nesvo/contracts';
import { MessageSquareShare } from 'lucide-react';
import { RelativeTime } from '@/entities/pull-request';
import { MessageBody } from '@/widgets/conversation/message-body';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Disclosure } from '@/shared/ui/disclosure';
import { ActionFeedback } from './action-feedback';
import { CommentBox } from './comment-box';
import { DisabledHint } from './disabled-hint';
import { isActionLocked, type ActionState } from './use-pull-request-actions';

type ThreadCardProps = {
  thread: PullRequestThread;
  now: number;
  showLocation: boolean;
  blockedReason: string;
  sendReason: string;
  replyState: ActionState | undefined;
  resolveState: ActionState | undefined;
  onReply: (body: string) => Promise<boolean>;
  onReplyEdit: () => void;
  onResolve: (resolved: boolean) => void;
  onSend: () => void;
};

export function ThreadCard({
  thread,
  now,
  showLocation,
  blockedReason,
  sendReason,
  replyState,
  resolveState,
  onReply,
  onReplyEdit,
  onResolve,
  onSend,
}: ThreadCardProps) {
  const [open, setOpen] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState('');
  const first = thread.comments[0];
  const resolving = resolveState?.status === 'pending';
  const resolveLocked = isActionLocked(resolveState);
  const submitReply = async () => {
    if (!(await onReply(body.trim()))) return;
    setBody('');
    setReplying(false);
  };
  return (
    <article
      aria-label={`Review thread on ${thread.path}${thread.line ? ` line ${thread.line}` : ''}`}
      data-thread-id={thread.id}
      className="my-1.5 overflow-hidden rounded-surface border bg-card font-sans text-foreground"
    >
      <Disclosure
        open={open}
        onOpenChange={setOpen}
        contentClassName="border-t p-0 text-foreground"
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-medium">
              {first?.author?.login ?? 'unknown'}
            </span>
            {showLocation && (
              <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                {thread.path}
                {thread.line ? `:${thread.line}` : ''}
              </span>
            )}
            {!open && first && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {first.body}
              </span>
            )}
          </span>
        }
        meta={
          (thread.isOutdated ||
            thread.isResolved ||
            thread.comments.length > 1) && (
            <span className="flex items-center gap-1.5">
              {thread.isOutdated && (
                <Badge tone="warning" size="xs">
                  Outdated
                </Badge>
              )}
              {thread.isResolved && <Badge size="xs">Resolved</Badge>}
              {thread.comments.length > 1 &&
                `${thread.comments.length} comments`}
            </span>
          )
        }
      >
        <ol className="divide-y">
          {thread.comments.map(comment => (
            <li key={comment.id} className="px-3 py-2">
              <p className="mb-1 flex items-center gap-2 text-2xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {comment.author?.login ?? 'unknown'}
                </span>
                <RelativeTime at={comment.createdAt} now={now} />
              </p>
              <MessageBody body={comment.body} className="text-xs leading-5" />
            </li>
          ))}
        </ol>
        {replying ? (
          <CommentBox
            label="Reply"
            placeholder="Reply to this thread"
            value={body}
            onChange={value => {
              setBody(value);
              onReplyEdit();
            }}
            submitLabel="Reply"
            canSubmit={!!body.trim()}
            state={replyState}
            blockedReason={blockedReason}
            onSubmit={() => void submitReply()}
            onCancel={() => setReplying(false)}
            autoFocus
            className="m-2"
          />
        ) : (
          <div className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
            {thread.viewerCanReply && (
              <DisabledHint reason={blockedReason}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!!blockedReason}
                  onClick={() => setReplying(true)}
                >
                  Reply
                </Button>
              </DisabledHint>
            )}
            {thread.viewerCanResolve && (
              <DisabledHint reason={blockedReason}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!!blockedReason || resolveLocked}
                  onClick={() => onResolve(!thread.isResolved)}
                >
                  {resolving
                    ? thread.isResolved
                      ? 'Reopening…'
                      : 'Resolving…'
                    : thread.isResolved
                      ? 'Unresolve'
                      : 'Resolve'}
                </Button>
              </DisabledHint>
            )}
            <DisabledHint
              reason={sendReason}
              hint="Put this thread into the session composer"
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!!sendReason}
                onClick={onSend}
              >
                <MessageSquareShare />
                Send to session
              </Button>
            </DisabledHint>
            <ActionFeedback state={resolveState} className="ml-1" />
            {replyState?.status === 'success' && (
              <ActionFeedback state={replyState} className="ml-1" />
            )}
          </div>
        )}
      </Disclosure>
    </article>
  );
}
