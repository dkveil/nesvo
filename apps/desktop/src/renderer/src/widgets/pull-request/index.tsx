import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { PullRequestThread } from '@nesvo/contracts';
import {
  Bot,
  Copy,
  Ellipsis,
  ExternalLink,
  Maximize2,
  RefreshCw,
  Unlink,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  PullRequestStateIcon,
  RelativeTime,
  primePullRequestDetails,
  pullRequestUrl,
  visualState,
  visualStateLabels,
  type PullRequestApi,
  type PullRequestTarget,
} from '@/entities/pull-request';
import { DiffStat } from '@/entities/file-change';
import { errorDetail, type Session } from '@/entities/session';
import { toneText } from '@/entities/status';
import { useNow } from '@/shared/lib/use-now';
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
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { Skeleton } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { TabPanel, Tabs } from '@/shared/ui/tabs';
import { Hint } from '@/shared/ui/tooltip';
import { AgentReviewTab, type AgentReviewApi } from './agent-review-tab';
import { CheckoutControl } from './checkout-control';
import type { AgentCommentTarget } from '@/features/code-comments/agent-target';
import { CodeTab } from './code-tab';
import { MergeControl } from './merge-control';
import { mergeHint } from './merge-hint';
import { openExternal } from './open-external';
import { ReviewControl } from './review-control';
import { reviewEvents, type ReviewDraft } from './review-event';
import {
  discussionPrompt,
  threadPrompt,
  threadsPrompt,
  type TimelineDiscussion,
} from './session-prompt';
import { SummaryTab } from './summary-tab';
import { ThreadCard } from './thread-card';
import { ThreadsTab } from './threads-tab';
import { TimelineTab } from './timeline-tab';
import { usePullRequestActions } from './use-pull-request-actions';
import { useResource } from './use-resource';

const RELATIVE_TIME_REFRESH_MS = 60_000;
const STALE_REVISION_REASON =
  'The pull request changed. Refresh to review the latest commit.';

const PANEL_ID_PREFIX = 'pull-request';

const EMPTY_REVIEW_DRAFT: ReviewDraft = { event: 'comment', body: '' };

type PanelTab = 'summary' | 'timeline' | 'code' | 'threads' | 'agent-review';

export type PullRequestPanelLayout = 'surface' | 'session';

type PullRequestPanelProps = {
  layout?: PullRequestPanelLayout;
  onExpand?: () => void;
  target: PullRequestTarget;
  api: PullRequestApi & AgentReviewApi;
  blockedReason: string;
  reviewBlockedReason?: string;
  reviewDirectory?: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenCodeReviewSettings?: () => void;
  linkedSession: Session | null;
  sendTargetTitle: string;
  onSendToSession: (text: string) => void;
  agentComments: AgentCommentTarget;
  onLinked: (session: Session) => void;
  onClose: () => void;
};

export default function PullRequestPanel({
  layout = 'surface',
  onExpand,
  target,
  api,
  blockedReason,
  reviewBlockedReason = '',
  reviewDirectory = '',
  onOpenSession,
  onOpenCodeReviewSettings,
  linkedSession,
  sendTargetTitle,
  onSendToSession,
  agentComments,
  onLinked,
  onClose,
}: PullRequestPanelProps) {
  const { reference } = target;
  const now = useNow(RELATIVE_TIME_REFRESH_MS);
  const [tab, setTab] = useState<PanelTab>('summary');
  const inSession = layout === 'session';
  const [codeRequested, setCodeRequested] = useState(inSession);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [versions, setVersions] = useState({
    pullRequest: 0,
    files: 0,
    threads: 0,
  });
  const [viewed, setViewed] = useState<Record<string, string[]>>({});
  const [menuNotice, setMenuNotice] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [storedReviewDraft, setReviewDraft] =
    useState<ReviewDraft>(EMPTY_REVIEW_DRAFT);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
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
  useEffect(() => {
    if (pullRequest.data)
      primePullRequestDetails(target.hostId, pullRequest.data);
  }, [pullRequest.data, target.hostId]);
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
    if (next === 'code' || next === 'threads') setCodeRequested(true);
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
  const changedPaths = files.data?.files.map(file => file.path) ?? [];
  const viewedCount = changedPaths.filter(path => viewedPaths.has(path)).length;
  const allowedReviewEvents = reviewEvents(!!data?.viewerCanReview);
  const reviewDraft = allowedReviewEvents.includes(storedReviewDraft.event)
    ? storedReviewDraft
    : { ...storedReviewDraft, event: 'comment' as const };
  const editReview = (draft: ReviewDraft) => {
    setReviewDraft(draft);
    actions.clear('review');
  };
  const submitReview = async () => {
    const done = await actions.run(
      'review',
      {
        action: 'review',
        event: reviewDraft.event,
        body: reviewDraft.body.trim(),
      },
      'Review submitted.',
    );
    if (done) {
      setReviewDraft(EMPTY_REVIEW_DRAFT);
      bump('pullRequest');
    }
    return done;
  };
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
      () => setMenuNotice({ tone: 'success', text: 'Link copied.' }),
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
      setMenuNotice({ tone: 'success', text: 'Unlinked from the session.' });
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
  const notice =
    menuNotice ??
    (actions.states.merge?.status === 'success'
      ? { tone: 'success' as const, text: actions.states.merge.message }
      : actions.states.checkout?.status === 'success'
        ? { tone: 'success' as const, text: actions.states.checkout.message }
        : actions.states.review?.status === 'success'
          ? { tone: 'success' as const, text: actions.states.review.message }
          : null);
  return (
    <SidePanel
      kind={inSession ? 'pull-request-review' : 'pull-request'}
      resizeLabel="Resize pull request panel"
      role="region"
      aria-label={`${inSession ? 'Review pull request' : 'Pull request'} ${reference.repository} #${reference.number}`}
      data-pull-request={`${reference.repository}#${reference.number}`}
      data-pull-request-layout={layout}
    >
      <SidePanelHeader
        closeLabel="Close pull request"
        onClose={onClose}
        closeRef={closeButton}
        leading={
          state ? (
            <PullRequestStateIcon state={state} />
          ) : (
            <span className="size-3.5 shrink-0" aria-hidden="true" />
          )
        }
        title={
          inSession ? (
            <>
              #{reference.number}{' '}
              <span className="font-normal text-muted-foreground">
                {reference.repository}
              </span>
              {state && (
                <span className="sr-only">, {visualStateLabels[state]}</span>
              )}
            </>
          ) : (
            <>
              <span className="font-normal text-muted-foreground">
                {reference.repository}
              </span>{' '}
              #{reference.number}
              {state && (
                <span className="sr-only">, {visualStateLabels[state]}</span>
              )}
            </>
          )
        }
      >
        {inSession && files.data && (
          <span
            className="mr-1 text-2xs text-muted-foreground tabular-nums"
            aria-live="polite"
            data-viewed-progress={`${viewedCount}/${changedPaths.length}`}
          >
            {viewedCount} / {changedPaths.length} viewed
          </span>
        )}
        {inSession && data?.state === 'open' && (
          <ReviewControl
            events={allowedReviewEvents}
            draft={reviewDraft}
            blockedReason={blockedReason}
            state={actions.states.review}
            onDraftChange={editReview}
            onSubmit={submitReview}
          />
        )}
        {inSession && onExpand && (
          <Hint label="Open in Pull requests" side="bottom">
            <PanelAction aria-label="Open in Pull requests" onClick={onExpand}>
              <Maximize2 />
            </PanelAction>
          </Hint>
        )}
        <Hint label="Open on GitHub" side="bottom">
          <PanelAction
            aria-label="Open on GitHub"
            onClick={() => openExternal(url)}
          >
            <ExternalLink />
          </PanelAction>
        </Hint>
        {!inSession && data && linkedSession && (
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
        {!inSession && data && (
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
        <Hint label="Review with agent" side="bottom">
          <PanelAction
            aria-label="Review with agent"
            disabled={!!(blockedReason || reviewBlockedReason)}
            onClick={() => {
              changeTab('agent-review');
              setReviewRequest(value => value + 1);
            }}
          >
            <Bot />
          </PanelAction>
        </Hint>
        <DropdownMenu>
          <Hint label="More" side="bottom">
            <DropdownMenuTrigger asChild>
              <PanelAction aria-label="More pull request actions">
                <Ellipsis />
              </PanelAction>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onSelect={copyLink}>
              <Copy />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!readable} onSelect={refreshAll}>
              <RefreshCw />
              Refresh
            </DropdownMenuItem>
            {linkedSession && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
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
      </SidePanelHeader>
      {notice && (
        <StatusMessage
          tone={notice.tone}
          className="shrink-0 animate-in border-b px-3 py-1.5 duration-base ease-out fade-in-0"
        >
          {notice.text}
        </StatusMessage>
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
              onClick={() => bump('pullRequest')}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading pull request" aria-busy="true">
            <div className="space-y-2 border-b px-3 py-3">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="w-1/2" />
            </div>
            <div className="flex h-9 items-center gap-4 border-b px-3">
              <Skeleton className="w-14" />
              <Skeleton className="w-14" />
              <Skeleton className="w-10" />
            </div>
            <div className="space-y-2.5 px-3 py-4">
              <Skeleton className="w-full" />
              <Skeleton className="w-11/12" />
              <Skeleton className="w-4/5" />
              <Skeleton className="w-2/3" />
            </div>
          </div>
        )
      ) : (
        <>
          <div className="shrink-0 border-b px-3 py-2.5">
            <p className="line-clamp-2 text-ui font-medium">{data.title}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
              <span>{data.author?.login ?? 'unknown'}</span>
              <span aria-hidden="true">·</span>
              <RelativeTime at={data.updatedAt} now={now} prefix="updated" />
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate font-mono">
                {data.baseRefName} ← {data.headRefName}
              </span>
              {hint && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={toneText[hint.tone]}>{hint.label}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1.5 tabular-nums">
                {data.changedFiles} files
                <DiffStat
                  additions={data.additions}
                  deletions={data.deletions}
                />
              </span>
              {pullRequest.status === 'loading' && (
                <StatusMessage tone="loading" className="ml-1">
                  Refreshing…
                </StatusMessage>
              )}
              {pullRequest.status === 'error' && (
                <StatusMessage tone="error" className="ml-1">
                  Could not refresh: {pullRequest.error}
                </StatusMessage>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center border-b">
            <Tabs
              label="Pull request sections"
              idPrefix={PANEL_ID_PREFIX}
              value={tab}
              onChange={changeTab}
              options={
                inSession
                  ? [
                      { value: 'summary', label: 'Summary' },
                      {
                        value: 'code',
                        label: 'Code',
                        count: data.changedFiles,
                      },
                      {
                        value: 'threads',
                        label: 'Threads',
                        count: threads.data?.threads.filter(
                          thread => !thread.isResolved,
                        ).length,
                      },
                    ]
                  : [
                      { value: 'summary', label: 'Summary' },
                      {
                        value: 'timeline',
                        label: 'Timeline',
                        count: data.timeline.length,
                      },
                      {
                        value: 'code',
                        label: 'Code',
                        count: data.changedFiles,
                      },
                      { value: 'agent-review', label: 'Agent review' },
                    ]
              }
              className="min-w-0 flex-1 border-b-0"
            />
            <div className="flex shrink-0 items-center gap-2 pr-2">
              {!inSession && tab === 'code' && files.data && (
                <span
                  className="text-2xs text-muted-foreground tabular-nums"
                  aria-live="polite"
                >
                  {viewedCount} / {changedPaths.length} viewed
                </span>
              )}
              {!inSession && data.state === 'open' && (
                <ReviewControl
                  events={allowedReviewEvents}
                  draft={reviewDraft}
                  blockedReason={blockedReason}
                  state={actions.states.review}
                  onDraftChange={editReview}
                  onSubmit={submitReview}
                />
              )}
            </div>
          </div>
          <TabPanel
            idPrefix={PANEL_ID_PREFIX}
            value={tab}
            className={cn(
              'flex min-h-0 flex-1 flex-col',
              tab !== 'code' &&
                tab !== 'threads' &&
                tab !== 'agent-review' &&
                'overflow-y-auto',
            )}
          >
            {tab === 'summary' && (
              <SummaryTab
                pullRequest={data}
                blockedReason={blockedReason}
                reviewEvents={allowedReviewEvents}
                reviewDraft={reviewDraft}
                reviewState={actions.states.review}
                onReviewDraftChange={editReview}
                onReview={() => void submitReview()}
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
            {tab === 'threads' && (
              <ThreadsTab
                threads={threads}
                sendReason={sendReason}
                onSendAll={sendThreads}
                onRetry={() => bump('threads')}
                renderThread={renderThread}
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
                agentComments={agentComments}
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
            {tab === 'agent-review' && (
              <AgentReviewTab
                api={api}
                hostId={target.hostId}
                reference={reference}
                currentHeadSha={headSha}
                defaultDirectory={reviewDirectory}
                blockedReason={blockedReason || reviewBlockedReason}
                now={now}
                startRequest={reviewRequest}
                onOpenSession={sessionId => onOpenSession?.(sessionId)}
                onOpenSettings={onOpenCodeReviewSettings}
              />
            )}
          </TabPanel>
          {sendTargetTitle && tab !== 'summary' && tab !== 'agent-review' && (
            <p className="shrink-0 truncate border-t px-3 py-1 text-2xs text-muted-foreground">
              Comments go to the composer of{' '}
              <span className="text-foreground">{sendTargetTitle}</span>.
              Nothing is sent until you press Send.
            </p>
          )}
        </>
      )}
    </SidePanel>
  );
}
