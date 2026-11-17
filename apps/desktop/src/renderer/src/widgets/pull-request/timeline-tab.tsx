import { useState } from 'react';
import type { PullRequest, PullRequestTimelineItem } from '@nesvo/contracts';
import { GitCommitHorizontal, MessageSquare } from 'lucide-react';
import { cn } from 'cn';
import { shortSha } from '@/entities/pull-request';
import { MessageBody } from '@/widgets/conversation/message-body';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { CommentBox } from './comment-box';
import type { ActionState } from './use-pull-request-actions';

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
  commentState: ActionState | undefined;
  onComment: (body: string) => Promise<boolean>;
  onCommentEdit: () => void;
};

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

function TimelineEntry({
  item,
  now,
}: {
  item: PullRequestTimelineItem;
  now: number;
}) {
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
        <MessageBody body={item.body} className="px-3 py-2 text-xs leading-5" />
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
  commentState,
  onComment,
  onCommentEdit,
}: TimelineTabProps) {
  const [body, setBody] = useState('');
  const items = [...pullRequest.timeline].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const submit = async () => {
    if (await onComment(body.trim())) setBody('');
  };
  return (
    <div className="space-y-3 px-4 py-4">
      {items.length > 0 ? (
        <ol aria-label="Timeline" className="space-y-2">
          {items.map(item => (
            <TimelineEntry key={itemKey(item)} item={item} now={now} />
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
      />
    </div>
  );
}
