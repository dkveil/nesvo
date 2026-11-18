import { useRef, useState } from 'react';
import type { PullRequest, PullRequestTimelineItem } from '@nesvo/contracts';
import {
  GitCommitHorizontal,
  MessageSquare,
  MessageSquareShare,
  Reply,
} from 'lucide-react';
import { RelativeTime, shortSha } from '@/entities/pull-request';
import { MessageBody } from '@/widgets/conversation/message-body';
import { Badge, type BadgeTone } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { ListRow } from '@/shared/ui/list-row';
import { CommentBox } from './comment-box';
import { DisabledHint } from '@/shared/ui/disabled-hint';
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

const REVIEW_STATE_TONES: Record<ReviewState, BadgeTone> = {
  approved: 'success',
  'changes-requested': 'error',
  commented: 'neutral',
  dismissed: 'neutral',
  pending: 'neutral',
};

const itemKey = (item: PullRequestTimelineItem) =>
  item.kind === 'commit' ? `commit:${item.oid}` : `${item.kind}:${item.id}`;

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
      <li>
        <ListRow
          leading={<GitCommitHorizontal />}
          title={
            <>
              <code className="font-mono text-2xs text-muted-foreground">
                {shortSha(item.oid)}
              </code>{' '}
              {item.headline}
            </>
          }
          trailing={
            <>
              <span className="max-w-24 truncate">{item.author}</span>
              <RelativeTime at={item.createdAt} now={now} />
            </>
          }
        />
      </li>
    );
  const author = item.author?.login ?? 'unknown';
  return (
    <li className="rounded-surface border bg-card">
      <div className="flex h-8 items-center gap-2 border-b px-3 text-xs">
        <MessageSquare
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate font-medium">{author}</span>
        {item.author?.isBot && (
          <Badge size="xs" appearance="outline">
            bot
          </Badge>
        )}
        {item.kind === 'review' && (
          <Badge size="xs" tone={REVIEW_STATE_TONES[item.state]}>
            {REVIEW_STATE_LABELS[item.state]}
          </Badge>
        )}
        <span className="flex-1" />
        <RelativeTime
          at={item.createdAt}
          now={now}
          className="shrink-0 text-2xs text-muted-foreground tabular-nums"
        />
      </div>
      {item.body.trim() ? (
        <>
          <MessageBody
            body={item.body}
            className="px-3 pt-2 text-xs leading-5"
          />
          <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
            <DisabledHint
              reason={replyReason}
              hint="Quote this in a new comment"
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!!replyReason}
                onClick={() => onReply(item)}
              >
                <Reply />
                Reply
              </Button>
            </DisabledHint>
            <DisabledHint
              reason={sendReason}
              hint="Put this into the session composer"
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!!sendReason}
                onClick={() => onSend(item)}
              >
                <MessageSquareShare />
                Send to session
              </Button>
            </DisabledHint>
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
        <EmptyState size="sm" icon={MessageSquare} title="No activity yet." />
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
