import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { PullRequestThread } from '@nesvo/contracts';
import {
  Copy,
  Ellipsis,
  ExternalLink,
  RefreshCw,
  Unlink,
  X,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  PullRequestStateIcon,
  pullRequestUrl,
  visualState,
  visualStateLabels,
  type PullRequestApi,
  type PullRequestTarget,
} from '@/entities/pull-request';
import { errorDetail, type Session } from '@/entities/session';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { usePanelWidth } from '@/shared/lib/use-panel-width';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { PanelAction } from '@/shared/ui/panel';
import { PanelResizer } from '@/shared/ui/panel-resizer';
import { panelSurface } from '@/shared/ui/panel-styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { CheckoutControl } from './checkout-control';
import { CodeTab } from './code-tab';
import { MergeControl } from './merge-control';
import { mergeHint } from './merge-hint';
import { openExternal } from './open-external';
import { PanelTabs, type PanelTab } from './panel-tabs';
import {
  discussionPrompt,
  threadPrompt,
  threadsPrompt,
  type TimelineDiscussion,
} from './session-prompt';
import { SummaryTab } from './summary-tab';
import { ThreadCard } from './thread-card';
import { TimelineTab } from './timeline-tab';
import { usePullRequestActions } from './use-pull-request-actions';
import { useResource } from './use-resource';

const RELATIVE_TIME_REFRESH_MS = 60_000;
const DEFAULT_WIDTH_RATIO = 0.56;
const DEFAULT_MAX_WIDTH_PX = 1000;

const defaultPanelWidth = (viewportWidth: number) =>
  Math.min(DEFAULT_MAX_WIDTH_PX, viewportWidth * DEFAULT_WIDTH_RATIO);

const STALE_REVISION_REASON =
  'The pull request changed. Refresh to review the latest commit.';

const HINT_TONES = {
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-muted-foreground',
} as const;

type PullRequestPanelProps = {
  target: PullRequestTarget;
  api: PullRequestApi;
  blockedReason: string;
  linkedSession: Session | null;
  sendTargetTitle: string;
  onSendToSession: (text: string) => void;
  onLinked: (session: Session) => void;
  onClose: () => void;
};

export default function PullRequestPanel({
  target,
  api,
  blockedReason,
  linkedSession,
  sendTargetTitle,
  onSendToSession,
  onLinked,
  onClose,
}: PullRequestPanelProps) {
  const { reference } = target;
  const now = useNow(RELATIVE_TIME_REFRESH_MS);
  const [tab, setTab] = useState<PanelTab>('summary');
  const [codeRequested, setCodeRequested] = useState(false);
  const [versions, setVersions] = useState({
    pullRequest: 0,
    files: 0,
    threads: 0,
  });
  const [viewed, setViewed] = useState<Record<string, string[]>>({});
  const [menuNotice, setMenuNotice] = useState<{
    tone: 'info' | 'error';
    text: string;
  } | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  const {
    attach: attachPanel,
    style: panelStyle,
    resizer,
  } = usePanelWidth('pull-request', defaultPanelWidth);
  const readable = !blockedReason;
  const pullRequest = useResource(
    () => api.readPullRequest(reference),
    `pull-request:${versions.pullRequest}`,
    readable,
  );
  const files = useResource(
    () => api.readPullRequestFiles(reference),
    `files:${versions.files}`,
    readable && codeRequested,
  );
  const threads = useResource(
    () => api.readPullRequestThreads(reference),
    `threads:${versions.threads}`,
    readable && codeRequested,
  );
  const bump = (key: keyof typeof versions) =>
    setVersions(previous => ({ ...previous, [key]: previous[key] + 1 }));
  const refreshAll = () => {
    setVersions(previous => ({
      pullRequest: previous.pullRequest + 1,
      files: previous.files + 1,
      threads: previous.threads + 1,
    }));
  };
  const actions = usePullRequestActions({
    api,
    reference,
    blockedReason,
    onRefresh: refreshAll,
  });
  useEffect(() => {
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(
          event.target instanceof Element &&
          event.target.closest(
            '[role="dialog"],[role="menu"],textarea,input:not([type="checkbox"]),[contenteditable="true"]',
          )
        )
      ) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const changeTab = (next: PanelTab) => {
    setTab(next);
    if (next === 'code') setCodeRequested(true);
  };
  const data = pullRequest.data;
  const url = data?.url ?? pullRequestUrl(reference);
  const headSha = files.data?.headSha ?? data?.headSha ?? '';
  const staleReason =
    data && files.data && files.data.headSha !== data.headSha
      ? STALE_REVISION_REASON
      : '';
  const commentReason = blockedReason || staleReason;
  const viewedPaths = new Set(viewed[headSha] ?? []);
  const toggleViewed = (path: string) =>
    setViewed(previous => {
      const current = previous[headSha] ?? [];
      return {
        ...previous,
        [headSha]: current.includes(path)
          ? current.filter(item => item !== path)
          : [...current, path],
      };
    });
  const sendReason = sendTargetTitle
    ? ''
    : 'Open a session to send review comments to it.';
  const sendDiscussion = (item: TimelineDiscussion) => {
    if (!sendTargetTitle) return;
    onSendToSession(
      discussionPrompt(
        reference,
        item,
        item.kind === 'review' ? 'review' : 'comment',
      ),
    );
  };
  const sendThreads = (items: PullRequestThread[]) => {
    if (!sendTargetTitle || items.length === 0) return;
    onSendToSession(
      items.length === 1
        ? threadPrompt(reference, items[0]!)
        : threadsPrompt(reference, items),
    );
  };
  const copyLink = () => {
    void navigator.clipboard.writeText(url).then(
      () => setMenuNotice({ tone: 'info', text: 'Link copied.' }),
      () => setMenuNotice({ tone: 'error', text: 'Could not copy the link.' }),
    );
  };
  const unlink = async () => {
    if (!linkedSession || unlinking) return;
    setUnlinking(true);
    setMenuNotice(null);
    try {
      onLinked(
        await api.linkSessionPullRequest({
          sessionId: linkedSession.id,
          pullRequest: null,
        }),
      );
      setMenuNotice({ tone: 'info', text: 'Unlinked from the session.' });
    } catch (failure) {
      setMenuNotice({
        tone: 'error',
        text: `Could not unlink. ${errorDetail(failure)}`,
      });
    } finally {
      setUnlinking(false);
    }
  };
  const renderThread = (thread: PullRequestThread, showLocation: boolean) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      now={now}
      showLocation={showLocation}
      blockedReason={blockedReason}
      sendReason={sendReason}
      replyState={actions.states[`reply:${thread.id}`]}
      resolveState={actions.states[`resolve:${thread.id}`]}
      onReplyEdit={() => actions.clear(`reply:${thread.id}`)}
      onReply={async body => {
        const done = await actions.run(
          `reply:${thread.id}`,
          { action: 'reply-thread', threadId: thread.id, body },
          'Reply posted.',
        );
        if (done) bump('threads');
        return done;
      }}
      onResolve={resolved =>
        void actions
          .run(
            `resolve:${thread.id}`,
            { action: 'resolve-thread', threadId: thread.id, resolved },
            resolved ? 'Thread resolved.' : 'Thread reopened.',
          )
          .then(done => {
            if (done) bump('threads');
          })
      }
      onSend={() => sendThreads([thread])}
    />
  );
  const state = data ? visualState(data) : null;
  const hint = data ? mergeHint(data) : null;
  return (
    <>
      <section
        role="region"
        aria-label={`Pull request ${reference.repository} #${reference.number}`}
        data-pull-request={`${reference.repository}#${reference.number}`}
        ref={attachPanel}
        style={panelStyle}
        className={panelSurface}
      >
        <PanelResizer label="Resize pull request panel" {...resizer} />
        <header className="drag-region flex h-(--shell-topbar-height) shrink-0 items-center gap-1.5 border-b pr-[calc(0.375rem+var(--panel-edge-inset))] pl-3">
          {state ? (
            <PullRequestStateIcon state={state} />
          ) : (
            <span className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <h2 className="min-w-0 truncate text-xs font-semibold">
            <span className="font-normal text-muted-foreground">
              {reference.repository}
            </span>{' '}
            #{reference.number}
            {state && (
              <span className="sr-only">, {visualStateLabels[state]}</span>
            )}
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <PanelAction
                aria-label="Open on GitHub"
                onClick={() => openExternal(url)}
              >
                <ExternalLink />
              </PanelAction>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open on GitHub</TooltipContent>
          </Tooltip>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {data && linkedSession && (
              <CheckoutControl
                pullRequest={data}
                session={linkedSession}
                blockedReason={blockedReason}
                state={actions.states.checkout}
                onCheckout={() =>
                  actions.run(
                    'checkout',
                    { action: 'checkout', sessionId: linkedSession.id },
                    'Checked out into the session folder.',
                  )
                }
              />
            )}
            {data && (
              <MergeControl
                pullRequest={data}
                blockedReason={blockedReason}
                staleReason={staleReason}
                state={actions.states.merge}
                onMerge={async (method, expectedHeadSha) => {
                  const done = await actions.run(
                    'merge',
                    { action: 'merge', method, expectedHeadSha },
                    'Merged.',
                  );
                  if (done) bump('pullRequest');
                  return done;
                }}
              />
            )}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <PanelAction aria-label="More pull request actions">
                      <Ellipsis />
                    </PanelAction>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">More</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem className="text-xs" onSelect={copyLink}>
                  <Copy />
                  Copy link
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs"
                  disabled={!readable}
                  onSelect={refreshAll}
                >
                  <RefreshCw />
                  Refresh
                </DropdownMenuItem>
                {linkedSession && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-xs"
                      disabled={!readable || unlinking}
                      onSelect={() => void unlink()}
                    >
                      <Unlink />
                      Unlink from session
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <PanelAction
              ref={closeButton}
              aria-label="Close pull request"
              onClick={onClose}
            >
              <X className="size-4" />
            </PanelAction>
          </div>
        </header>
        {(menuNotice ||
          (actions.states.merge?.status === 'success' &&
            actions.states.merge) ||
          (actions.states.checkout?.status === 'success' &&
            actions.states.checkout)) && (
          <p
            role={menuNotice?.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'shrink-0 animate-in border-b px-3 py-1.5 text-2xs duration-150 fade-in-0',
              menuNotice?.tone === 'error'
                ? 'text-error-foreground'
                : 'text-success-foreground',
            )}
          >
            {menuNotice?.text ??
              (actions.states.merge?.status === 'success'
                ? actions.states.merge.message
                : actions.states.checkout?.message)}
          </p>
        )}
        {blockedReason ? (
          <InlineNotice className="m-3">{blockedReason}</InlineNotice>
        ) : !data ? (
          pullRequest.status === 'error' ? (
            <div className="flex flex-wrap items-center gap-2 p-3">
              <InlineNotice tone="error" className="min-w-0 flex-1">
                {pullRequest.error}
              </InlineNotice>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => bump('pullRequest')}
              >
                Try again
              </Button>
            </div>
          ) : (
            <p role="status" className="p-4 text-xs text-muted-foreground">
              Loading pull request…
            </p>
          )
        ) : (
          <>
            <div className="shrink-0 border-b px-3 py-2.5">
              <p
                className="line-clamp-2 text-[13px] leading-5 font-medium"
                title={data.title}
              >
                {data.title}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
                <span>{data.author?.login ?? 'unknown'}</span>
                <span aria-hidden="true">·</span>
                <time
                  dateTime={data.updatedAt}
                  title={new Date(data.updatedAt).toLocaleString()}
                >
                  updated {formatRelativeTime(data.updatedAt, now)}
                </time>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate font-mono">
                  {data.baseRefName} ← {data.headRefName}
                </span>
                {hint && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className={HINT_TONES[hint.tone]}>{hint.label}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {data.changedFiles} files{' '}
                  <span className="font-mono text-success-foreground">
                    +{data.additions}
                  </span>{' '}
                  <span className="font-mono text-error-foreground">
                    −{data.deletions}
                  </span>
                </span>
                {pullRequest.status === 'loading' && (
                  <span role="status" className="ml-1">
                    Refreshing…
                  </span>
                )}
                {pullRequest.status === 'error' && (
                  <span role="alert" className="ml-1 text-error-foreground">
                    Could not refresh: {pullRequest.error}
                  </span>
                )}
              </p>
            </div>
            <PanelTabs
              value={tab}
              onChange={changeTab}
              options={[
                { value: 'summary', label: 'Summary' },
                {
                  value: 'timeline',
                  label: 'Timeline',
                  count: data.timeline.length,
                },
                { value: 'code', label: 'Code', count: data.changedFiles },
              ]}
            />
            <div
              role="tabpanel"
              id={`pull-request-panel-${tab}`}
              aria-labelledby={`pull-request-tab-${tab}`}
              className={cn(
                'flex min-h-0 flex-1 flex-col',
                tab !== 'code' && 'overflow-y-auto',
              )}
            >
              {tab === 'summary' && (
                <SummaryTab
                  pullRequest={data}
                  blockedReason={blockedReason}
                  reviewState={actions.states.review}
                  onReviewEdit={() => actions.clear('review')}
                  onReview={async (event, body) => {
                    const done = await actions.run(
                      'review',
                      { action: 'review', event, body },
                      'Review submitted.',
                    );
                    if (done) bump('pullRequest');
                    return done;
                  }}
                />
              )}
              {tab === 'timeline' && (
                <TimelineTab
                  pullRequest={data}
                  now={now}
                  blockedReason={blockedReason}
                  sendReason={sendReason}
                  onSend={sendDiscussion}
                  commentState={actions.states.comment}
                  onCommentEdit={() => actions.clear('comment')}
                  onComment={async body => {
                    const done = await actions.run(
                      'comment',
                      { action: 'comment', body },
                      'Comment posted.',
                    );
                    if (done) bump('pullRequest');
                    return done;
                  }}
                />
              )}
              {tab === 'code' && (
                <CodeTab
                  files={files}
                  threads={threads}
                  viewed={viewedPaths}
                  sendReason={sendReason}
                  commentReason={commentReason}
                  staleReason={staleReason}
                  lineCommentState={actions.states['line-comment']}
                  onRefresh={refreshAll}
                  onLineCommentEdit={() => actions.clear('line-comment')}
                  onLineComment={async draft => {
                    if (!files.data) return false;
                    const done = await actions.run(
                      'line-comment',
                      {
                        action: 'line-comment',
                        commitId: files.data.headSha,
                        path: draft.path,
                        side: draft.side,
                        line: draft.line,
                        startLine: draft.startLine,
                        body: draft.body,
                      },
                      'Comment posted.',
                    );
                    if (done) bump('threads');
                    return done;
                  }}
                  onToggleViewed={toggleViewed}
                  onSendAll={sendThreads}
                  onRetry={() => {
                    bump('files');
                    bump('threads');
                  }}
                  renderThread={renderThread}
                />
              )}
            </div>
            {sendTargetTitle && tab !== 'summary' && (
              <p className="shrink-0 truncate border-t px-3 py-1 text-2xs text-muted-foreground">
                Comments go to the composer of{' '}
                <span className="text-foreground">{sendTargetTitle}</span>.
                Nothing is sent until you press Send.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
