import { useState } from 'react';
import type { PullRequestThread } from '@nesvo/contracts';
import { ChevronRight, MessageSquareShare } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { MessageBody } from '@/widgets/conversation/message-body';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { ActionFeedback } from './action-feedback';
import { CommentBox } from './comment-box';
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
      className="my-1.5 overflow-hidden rounded-lg border bg-card font-sans text-foreground"
    >
      <header className="flex h-7 items-center gap-1.5 px-2 text-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Collapse thread' : 'Expand thread'}
          onClick={() => setOpen(value => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
              open && 'rotate-90',
            )}
          />
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
        </button>
        {thread.isOutdated && (
          <span className="shrink-0 rounded-full bg-accent px-1.5 text-2xs leading-4 text-warning-foreground">
            Outdated
          </span>
        )}
        {thread.isResolved && (
          <span className="shrink-0 rounded-full bg-accent px-1.5 text-2xs leading-4 text-muted-foreground">
            Resolved
          </span>
        )}
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
          {thread.comments.length > 1
            ? `${thread.comments.length} comments`
            : ''}
        </span>
      </header>
      {open && (
        <div className="animate-in border-t duration-150 fade-in-0">
          <ol className="divide-y">
            {thread.comments.map(comment => (
              <li key={comment.id} className="px-3 py-2">
                <p className="mb-1 flex items-center gap-2 text-2xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {comment.author?.login ?? 'unknown'}
                  </span>
                  <time
                    dateTime={comment.createdAt}
                    title={new Date(comment.createdAt).toLocaleString()}
                  >
                    {formatRelativeTime(comment.createdAt, now)}
                  </time>
                </p>
                <MessageBody
                  body={comment.body}
                  className="text-xs leading-5"
                />
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
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!!blockedReason}
                  title={blockedReason || undefined}
                  onClick={() => setReplying(true)}
                  className="text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed"
                >
                  Reply
                </Button>
              )}
              {thread.viewerCanResolve && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!!blockedReason || resolveLocked}
                  title={blockedReason || undefined}
                  onClick={() => onResolve(!thread.isResolved)}
                  className="text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed"
                >
                  {resolving
                    ? thread.isResolved
                      ? 'Reopening…'
                      : 'Resolving…'
                    : thread.isResolved
                      ? 'Unresolve'
                      : 'Resolve'}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!!sendReason}
                title={
                  sendReason || 'Put this thread into the session composer'
                }
                onClick={onSend}
                className="text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed"
              >
                <MessageSquareShare />
                Send to session
              </Button>
              <ActionFeedback state={resolveState} className="ml-1" />
              {replyState?.status === 'success' && (
                <ActionFeedback state={replyState} className="ml-1" />
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
