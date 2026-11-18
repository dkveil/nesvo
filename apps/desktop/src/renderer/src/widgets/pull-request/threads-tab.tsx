import type { ReactNode } from 'react';
import type { PullRequestThread, PullRequestThreads } from '@nesvo/contracts';
import { MessageSquareShare, MessagesSquare } from 'lucide-react';
import { CountBadge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { DisabledHint } from '@/shared/ui/disabled-hint';
import { EmptyState } from '@/shared/ui/empty-state';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Toolbar, ToolbarSpacer } from '@/shared/ui/panel';
import { SectionLabel } from '@/shared/ui/section-label';
import { SkeletonList } from '@/shared/ui/skeleton';
import type { Resource } from './use-resource';

type ThreadsTabProps = {
  threads: Resource<PullRequestThreads>;
  sendReason: string;
  onSendAll: (threads: PullRequestThread[]) => void;
  onRetry: () => void;
  renderThread: (thread: PullRequestThread, showLocation: boolean) => ReactNode;
};

export function ThreadsTab({
  threads,
  sendReason,
  onSendAll,
  onRetry,
  renderThread,
}: ThreadsTabProps) {
  if (threads.status === 'error' && !threads.data)
    return (
      <div className="flex flex-wrap items-center gap-2 p-4">
        <InlineNotice tone="error" className="min-w-0 flex-1">
          {threads.error}
        </InlineNotice>
        <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (!threads.data)
    return (
      <SkeletonList
        label="Loading review threads"
        rows={4}
        className="px-1 py-2"
      />
    );
  const all = threads.data.threads;
  const open = all.filter(thread => !thread.isResolved);
  const resolved = all.filter(thread => thread.isResolved);
  if (all.length === 0)
    return (
      <EmptyState
        size="sm"
        icon={MessagesSquare}
        title="No review threads"
        description="Line comments from the Code tab start a thread here."
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        label="Review threads"
        className="text-2xs text-muted-foreground"
      >
        <span className="pl-1 tabular-nums">
          {open.length} open · {resolved.length} resolved
        </span>
        {threads.data.truncated && (
          <span className="shrink-0">Some threads are not listed</span>
        )}
        <ToolbarSpacer />
        <DisabledHint
          reason={sendReason}
          hint={
            open.length === 0
              ? 'No open review threads'
              : 'Put every open thread into the session composer'
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={open.length === 0 || !!sendReason}
            onClick={() => onSendAll(open)}
          >
            <MessageSquareShare />
            Send all open threads
            <CountBadge count={open.length} tone="muted" />
          </Button>
        </DisabledHint>
      </Toolbar>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {open.map(thread => renderThread(thread, true))}
        {resolved.length > 0 && (
          <>
            <SectionLabel className="px-1 pt-2">Resolved</SectionLabel>
            {resolved.map(thread => renderThread(thread, true))}
          </>
        )}
      </div>
    </div>
  );
}
