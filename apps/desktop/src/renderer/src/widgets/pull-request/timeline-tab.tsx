import { useRef, useState } from 'react';
import type { PullRequest, PullRequestTimelineItem } from '@nesvo/contracts';
import {
  GitCommitHorizontal,
  MessageSquare,
  MessageSquareShare,
  Reply,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { shortSha } from '@/entities/pull-request';
import { MessageBody } from '@/widgets/conversation/message-body';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { Button } from '@/shared/ui/button';
import { CommentBox } from './comment-box';
import { replyQuote, type TimelineDiscussion } from './session-prompt';
import { isActionLocked, type ActionState } from './use-pull-request-actions';

type ReviewState = Extract<
  PullRequestTimelineItem,
  { kind: 'review' }
>['state'];

const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  approved: 'Approved',
  'changes-requested': 'Requested changes',
  commented: 'Reviewed',
  dismissed: 'Dismissed',
  pending: 'Pending',
};

type TimelineTabProps = {
  pullRequest: PullRequest;
  now: number;
  blockedReason: string;
  sendReason: string;
  commentState: ActionState | undefined;
  onComment: (body: string) => Promise<boolean>;
  onCommentEdit: () => void;
  onSend: (item: TimelineDiscussion) => void;
};

const ENTRY_ACTION =
  'h-6 text-2xs text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed';

const itemKey = (item: PullRequestTimelineItem) =>
  item.kind === 'commit' ? `commit:${item.oid}` : `${item.kind}:${item.id}`;

function When({ at, now }: { at: string; now: number }) {
  return (
    <time
      dateTime={at}
      title={new Date(at).toLocaleString()}
      className="shrink-0 text-2xs text-muted-foreground tabular-nums"
    >
      {formatRelativeTime(at, now)}
    </time>
  );
}

type TimelineEntryProps = {
  item: PullRequestTimelineItem;
  now: number;
  replyReason: string;
  sendReason: string;
  onReply: (item: TimelineDiscussion) => void;
  onSend: (item: TimelineDiscussion) => void;
};

function TimelineEntry({
  item,
  now,
  replyReason,
  sendReason,
  onReply,
  onSend,
}: TimelineEntryProps) {
  if (item.kind === 'commit')
    return (
      <li className="flex h-6 items-center gap-2 px-1 text-xs">
        <GitCommitHorizontal
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <code className="shrink-0 font-mono text-2xs text-muted-foreground">
          {shortSha(item.oid)}
        </code>
        <span className="min-w-0 flex-1 truncate" title={item.headline}>
          {item.headline}
        </span>
        <span className="max-w-24 shrink-0 truncate text-2xs text-muted-foreground">
          {item.author}
        </span>
        <When at={item.createdAt} now={now} />
      </li>
    );
  const author = item.author?.login ?? 'unknown';
  return (
    <li className="rounded-lg border bg-card">
      <div className="flex h-7 items-center gap-2 border-b px-3 text-xs">
        <MessageSquare
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate font-medium">{author}</span>
        {item.author?.isBot && (
          <span className="text-2xs text-muted-foreground">bot</span>
        )}
        {item.kind === 'review' && (
          <span
            className={cn(
              'rounded-full px-1.5 text-2xs leading-4',
              item.state === 'approved' && 'bg-accent text-success-foreground',
              item.state === 'changes-requested' &&
                'bg-accent text-error-foreground',
              item.state !== 'approved' &&
                item.state !== 'changes-requested' &&
                'bg-accent text-muted-foreground',
            )}
          >
            {REVIEW_STATE_LABELS[item.state]}
          </span>
        )}
        <span className="flex-1" />
        <When at={item.createdAt} now={now} />
      </div>
      {item.body.trim() ? (
        <>
          <MessageBody
            body={item.body}
            className="px-3 pt-2 text-xs leading-5"
          />
          <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!!replyReason}
              title={replyReason || 'Quote this in a new comment'}
              onClick={() => onReply(item)}
              className={ENTRY_ACTION}
            >
              <Reply />
              Reply
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!!sendReason}
              title={sendReason || 'Put this into the session composer'}
              onClick={() => onSend(item)}
              className={ENTRY_ACTION}
            >
              <MessageSquareShare />
              Send to session
            </Button>
          </div>
        </>
      ) : (
        <p className="px-3 py-2 text-2xs text-muted-foreground">No comment.</p>
      )}
    </li>
  );
}

export function TimelineTab({
  pullRequest,
  now,
  blockedReason,
  sendReason,
  commentState,
  onComment,
  onCommentEdit,
  onSend,
}: TimelineTabProps) {
  const [body, setBody] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const replyReason =
    blockedReason ||
    (isActionLocked(commentState)
      ? 'Wait until the current comment is settled.'
      : '');
  const items = [...pullRequest.timeline].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const submit = async () => {
    if (await onComment(body.trim())) setBody('');
  };
  const reply = (item: TimelineDiscussion) => {
    const quoted = replyQuote(item);
    const next = body.trim()
      ? `${body.trimEnd()}

${quoted}`
      : quoted;
    setBody(next);
    onCommentEdit();
    requestAnimationFrame(() => {
      const field = composer.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(next.length, next.length);
      field.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
    });
  };
  return (
    <div className="space-y-3 px-4 py-4">
      {items.length > 0 ? (
        <ol aria-label="Timeline" className="space-y-2">
          {items.map(item => (
            <TimelineEntry
              key={itemKey(item)}
              item={item}
              now={now}
              replyReason={replyReason}
              sendReason={sendReason}
              onReply={reply}
              onSend={onSend}
            />
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">No activity yet.</p>
      )}
      <CommentBox
        label="Comment"
        placeholder="Add a comment"
        value={body}
        onChange={value => {
          setBody(value);
          onCommentEdit();
        }}
        submitLabel="Comment"
        canSubmit={!!body.trim()}
        state={commentState}
        blockedReason={blockedReason}
        onSubmit={() => void submit()}
        textareaRef={composer}
      />
    </div>
  );
}
