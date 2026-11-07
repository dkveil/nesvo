import { lazy, Suspense, useRef, useState } from 'react';
import type {
  CreateSessionInput,
  DecideDelegationInput,
  DecideReviewInput,
  Review,
  RespondApprovalInput,
} from '@nesvo/contracts';
import { ArrowLeft, Menu, PanelRight, Plus, RefreshCw } from 'lucide-react';
import {
  errorDetail,
  providers,
  providerStatusLabel,
  sessionRoleLabel,
  sessionStatusLabel,
} from '@/entities/session';
import { CreateSession } from '@/features/create-session';
import { HostStatus } from '@/features/host-status';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/ui/sheet';
import { Conversation } from '@/widgets/conversation';
import { Delegations } from '@/widgets/delegations';
import { ReviewInbox } from '@/widgets/review-inbox';
import { SessionDetails } from '@/widgets/session-details';
import { SessionActivity } from '@/widgets/session-activity';
import { SessionReviews } from '@/widgets/session-reviews';
import { SessionSidebar } from '@/widgets/session-sidebar';
import { desktopApi, useSessions } from './use-sessions';

const ReviewDiff = lazy(() => import('@/widgets/review-diff'));

export function Workspace() {
  const store = useSessions();
  const [selectedId, setSelectedId] = useState('');
  const [inbox, setInbox] = useState(false);
  const [sessionTarget, setSessionTarget] = useState('');
  const [diffTarget, setDiffTarget] = useState<{
    reviewId: string;
    path?: string;
  } | null>(null);
  const diffTrigger = useRef<HTMLElement | null>(null);
  const [reviewFeedbacks, setReviewFeedbacks] = useState<
    Record<string, string>
  >({});
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [reviewPending, setReviewPending] = useState<Record<string, boolean>>(
    {},
  );
  const reviewRequests = useRef(new Set<string>());
  const reviewAttempts = useRef<Record<string, DecideReviewInput>>({});
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [approvalPending, setApprovalPending] = useState<
    Record<string, boolean>
  >({});
  const approvalRequests = useRef(new Set<string>());
  const [delegationPending, setDelegationPending] = useState<
    Record<string, boolean>
  >({});
  const delegationRequests = useRef(new Set<string>());
  const draftVersions = useRef<Record<string, number>>({});
  const sendAttempts = useRef<
    Record<string, { text: string; messageId: string }>
  >({});
  const stopping = useRef(new Set<string>());
  const createTrigger = useRef<HTMLElement | null>(null);
  const selected =
    store.sessions.find(session => session.id === selectedId) ??
    store.sessions[0];
  const parentSession = store.sessions.find(
    session => session.id === selected?.parentId,
  );
  const workers = store.sessions.filter(
    session => session.parentId === selected?.id,
  );
  const selectedProviderState = selected
    ? store.providerStates[selected.provider]
    : undefined;
  const activeRun = store.sessions.find(
    session => session.status === 'running' || session.status === 'stopping',
  );
  const diffReview =
    !inbox && diffTarget
      ? store.reviews.find(
          review =>
            review.id === diffTarget.reviewId &&
            review.sessionId === selected?.id,
        )
      : undefined;
  const openDiff = (reviewId: string, path?: string) => {
    diffTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDiffTarget({ reviewId, path });
  };
  const closeDiff = () => {
    setDiffTarget(null);
    if (diffTrigger.current?.isConnected) diffTrigger.current.focus();
  };
  const select = (id: string, targetId = '') => {
    setDiffTarget(null);
    setSelectedId(id);
    setSessionTarget(targetId);
    setInbox(false);
    setNavigationOpen(false);
    setDetailsOpen(false);
  };
  const openInbox = () => {
    setDiffTarget(null);
    setInbox(true);
    setNavigationOpen(false);
  };
  const openCreate = () => {
    createTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setNavigationOpen(false);
    setCreating(true);
  };
  const create = async (input: CreateSessionInput) => {
    const session = await desktopApi().createSession(input);
    store.merge([session]);
    select(session.id);
    return session;
  };
  const changeDraft = (id: string, value: string) => {
    draftVersions.current[id] = (draftVersions.current[id] ?? 0) + 1;
    setDrafts(previous => ({ ...previous, [id]: value }));
  };
  const send = async () => {
    if (
      !selected ||
      sendingRef.current ||
      activeRun ||
      store.connection !== 'ready' ||
      selectedProviderState?.status?.status !== 'ready' ||
      selectedProviderState.loading ||
      selectedProviderState.error
    )
      return;
    const sessionId = selected.id;
    const text = drafts[sessionId]?.trim();
    if (!text || text.length > 32000) return;
    const version = draftVersions.current[sessionId] ?? 0;
    const prior = sendAttempts.current[sessionId];
    const attempt =
      prior?.text === text ? prior : { text, messageId: crypto.randomUUID() };
    sendAttempts.current[sessionId] = attempt;
    sendingRef.current = true;
    setSending(true);
    setErrors(previous => ({ ...previous, [sessionId]: '' }));
    const acknowledge = () => {
      delete sendAttempts.current[sessionId];
      if ((draftVersions.current[sessionId] ?? 0) === version)
        setDrafts(previous => ({ ...previous, [sessionId]: '' }));
    };
    try {
      const session = await desktopApi().sendMessage({
        sessionId,
        messageId: attempt.messageId,
        text,
      });
      store.merge([session]);
      acknowledge();
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [sessionId]: `Could not confirm that the message was sent. ${errorDetail(failure)}`,
      }));
      try {
        const history = await store.recover();
        if (
          history
            .find(session => session.id === sessionId)
            ?.messages.some(message => message.id === attempt.messageId)
        )
          acknowledge();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionId]: `${previous[sessionId] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)} You can retry the same message.`,
        }));
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const stop = async () => {
    if (
      !selected?.runId ||
      selected.status !== 'running' ||
      stopping.current.has(selected.runId)
    )
      return;
    const { id: sessionId, runId } = selected;
    stopping.current.add(runId);
    setErrors(previous => ({ ...previous, [sessionId]: '' }));
    try {
      store.merge([await desktopApi().stopRun({ sessionId, runId })]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [sessionId]: `Could not stop the run. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionId]: `${previous[sessionId] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
        }));
      }
    } finally {
      stopping.current.delete(runId);
    }
  };
  const respondApproval = async (input: RespondApprovalInput) => {
    const session = store.sessions.find(item => item.id === input.sessionId);
    if (
      !session ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      store.connection !== 'ready' ||
      store.loading ||
      store.error ||
      !session.pendingApprovals.some(
        approval => approval.id === input.requestId,
      )
    )
      return;
    const { sessionId, runId, requestId } = input;
    const key = `${sessionId}/${runId}/${requestId}`;
    if (approvalRequests.current.has(key)) return;
    approvalRequests.current.add(key);
    setApprovalPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [sessionId]: '' }));
    try {
      store.merge([await desktopApi().respondApproval(input)]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [sessionId]: `Could not send the decision. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionId]: `${previous[sessionId] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
        }));
      }
    } finally {
      approvalRequests.current.delete(key);
      setApprovalPending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  const decideDelegation = async (input: DecideDelegationInput) => {
    const session = store.sessions.find(item => item.id === input.sessionId);
    if (
      !session ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      store.connection !== 'ready' ||
      store.loading ||
      store.error ||
      !session.delegations.some(
        delegation =>
          delegation.id === input.delegationId &&
          delegation.runId === input.runId &&
          delegation.status === 'pending',
      )
    )
      return;
    const { sessionId, runId, delegationId } = input;
    const key = `${sessionId}/${runId}/${delegationId}`;
    if (delegationRequests.current.has(key)) return;
    delegationRequests.current.add(key);
    setDelegationPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [sessionId]: '' }));
    try {
      store.merge([await desktopApi().decideDelegation(input)]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [sessionId]: `Could not send the worker decision. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionId]: `${previous[sessionId] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
        }));
      }
    } finally {
      delegationRequests.current.delete(key);
      setDelegationPending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  const reviewBlockedReason =
    store.connection !== 'ready'
      ? 'Reconnect before making a decision.'
      : store.loading || store.error
        ? 'Refresh the session state before making a decision.'
        : activeRun || sending
          ? 'Result review is available once all sessions and workers finish.'
          : '';
  const decideReview = async (
    review: Review,
    decision: DecideReviewInput['decision'],
    feedback: string,
  ) => {
    if (reviewRequests.current.has(review.id) || reviewBlockedReason) return;
    if (
      review.status !== 'pending' ||
      (decision === 'accept' && review.diff.status === 'unavailable') ||
      (decision === 'request-changes' && !feedback.trim())
    )
      return;
    const prior = reviewAttempts.current[review.id];
    const attempt =
      prior?.version === review.version &&
      prior.decision === decision &&
      prior.feedback === feedback.trim()
        ? prior
        : {
            reviewId: review.id,
            version: review.version,
            decisionId: crypto.randomUUID(),
            decision,
            feedback: feedback.trim(),
          };
    reviewAttempts.current[review.id] = attempt;
    reviewRequests.current.add(review.id);
    setReviewPending(previous => ({ ...previous, [review.id]: true }));
    setReviewErrors(previous => ({ ...previous, [review.id]: '' }));
    const acknowledge = (result: Review) => {
      store.mergeReviews([result]);
      setReviewErrors(previous => ({ ...previous, [review.id]: '' }));
      delete reviewAttempts.current[review.id];
      if (attempt.decision === 'request-changes') {
        select(result.sessionId);
        void store.recover().catch(failure =>
          setErrors(previous => ({
            ...previous,
            [result.sessionId]: `The correction was requested, but the conversation could not be refreshed. ${errorDetail(failure)}`,
          })),
        );
      }
    };
    try {
      acknowledge(await desktopApi().decideReview(attempt));
    } catch (failure) {
      setReviewErrors(previous => ({
        ...previous,
        [review.id]: `Could not save the decision. ${errorDetail(failure)}`,
      }));
      try {
        const history = await store.recoverReviews();
        const confirmed = history.find(
          result =>
            result.id === review.id &&
            result.decision?.id === attempt.decisionId,
        );
        if (confirmed) acknowledge(confirmed);
      } catch (recoveryFailure) {
        setReviewErrors(previous => ({
          ...previous,
          [review.id]: `${previous[review.id] ?? ''} Could not refresh the results. ${errorDetail(recoveryFailure)} Retrying the same decision will not create a duplicate request.`,
        }));
      }
    } finally {
      reviewRequests.current.delete(review.id);
      setReviewPending(previous => {
        const next = { ...previous };
        delete next[review.id];
        return next;
      });
    }
  };
  const reviewDecisionProps = {
    blockedReason: reviewBlockedReason,
    pending: reviewPending,
    decisionErrors: reviewErrors,
    feedbacks: reviewFeedbacks,
    onFeedback: (reviewId: string, value: string) =>
      setReviewFeedbacks(previous => ({ ...previous, [reviewId]: value })),
    onDecision: (
      review: Review,
      decision: DecideReviewInput['decision'],
      feedback: string,
    ) => void decideReview(review, decision, feedback),
  };
  const operationEnabled =
    store.connection === 'ready' && !store.loading && !store.error;
  const sidebarProps = {
    sessions: store.sessions,
    pendingActions:
      store.reviews.filter(review => review.status === 'pending').length +
      store.sessions.reduce(
        (count, session) =>
          count +
          (session.status === 'running' && session.runId
            ? session.pendingApprovals.length +
              session.delegations.filter(
                item =>
                  item.runId === session.runId && item.status === 'pending',
              ).length
            : 0),
        0,
      ),
    selectedId: selected?.id ?? '',
    inbox,
    onSelect: select,
    onInbox: openInbox,
    onCreate: openCreate,
  };
  const providerIssue =
    !inbox &&
    selectedProviderState &&
    (selectedProviderState.error ||
      selectedProviderState.status?.status !== 'ready')
      ? selectedProviderState
      : null;
  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background">
      <aside className="hidden w-60 shrink-0 border-r bg-[#080808] md:block">
        <SessionSidebar {...sidebarProps} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-1.5 lg:px-5">
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open sessions"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 gap-0 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>Sessions and inbox.</SheetDescription>
              </SheetHeader>
              <SessionSidebar {...sidebarProps} />
            </SheetContent>
          </Sheet>
          {parentSession && !inbox && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to parent session"
              title={`Back to: ${parentSession.title}`}
              onClick={() => select(parentSession.id)}
            >
              <ArrowLeft />
            </Button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <h1 className="truncate text-[13px] font-medium">
              {inbox ? 'Inbox' : (selected?.title ?? 'New session')}
            </h1>
            {!inbox && selected && sessionRoleLabel(selected) && (
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                {sessionRoleLabel(selected)}
              </span>
            )}
          </div>
          {!inbox && selected && selected.status !== 'ready' && (
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
              {sessionStatusLabel(selected)}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="New session"
            onClick={openCreate}
          >
            <Plus />
          </Button>
          <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Open context"
                title="Context and connection"
              >
                <PanelRight className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent className="gap-0 bg-card">
              <SheetHeader className="border-b px-5 py-4">
                <SheetTitle className="text-sm">Context</SheetTitle>
                <SheetDescription className="text-xs">
                  Session details and local connection.
                </SheetDescription>
              </SheetHeader>
              <ScrollArea className="min-h-0 flex-1">
                {!inbox && selected && <SessionDetails session={selected} />}
                <section
                  aria-label="Connection"
                  className="space-y-5 border-t p-5"
                >
                  <h2 className="text-xs font-medium">Connection</h2>
                  <HostStatus
                    connection={store.connection}
                    onRefresh={store.refresh}
                  />
                  {providers.map(provider => {
                    const state = store.providerStates[provider];
                    return (
                      <div key={provider} className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium">
                            {provider}
                          </span>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Refresh ${provider} status`}
                            title={`Refresh ${provider} status`}
                            disabled={state.loading}
                            onClick={() => void store.refreshProvider(provider)}
                          >
                            <RefreshCw />
                          </Button>
                        </div>
                        <p
                          role="status"
                          className="text-xs text-muted-foreground"
                        >
                          {providerStatusLabel(provider, state)}
                        </p>
                        {state.error && (
                          <p
                            role="alert"
                            className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
                          >
                            {state.error}
                          </p>
                        )}
                        {state.status?.detail && (
                          <p className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                            {state.status.detail}
                          </p>
                        )}
                        {state.status?.status === 'unauthenticated' && (
                          <p className="text-xs leading-5 text-muted-foreground">
                            Sign in from your terminal with{' '}
                            <code>
                              {provider === 'Claude Code'
                                ? 'claude auth login'
                                : 'codex login'}
                            </code>
                            , then refresh status.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </section>
              </ScrollArea>
            </SheetContent>
          </Sheet>
        </header>
        {store.error && (
          <div className="flex max-h-32 shrink-0 flex-wrap items-center gap-3 overflow-y-auto border-b px-5 py-2.5">
            <p
              role="alert"
              className="min-w-0 text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
            >
              {store.error}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.location.reload()}
            >
              Reload window
            </Button>
          </div>
        )}
        {providerIssue && selected && (
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-2">
            <p
              role={providerIssue.error ? 'alert' : 'status'}
              className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
            >
              {providerIssue.error ||
                providerStatusLabel(selected.provider, providerIssue)}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs text-muted-foreground"
              onClick={() => setDetailsOpen(true)}
            >
              View status
            </Button>
          </div>
        )}
        <main className="relative flex min-h-0 min-w-0 flex-1">
          {inbox ? (
            <ReviewInbox
              {...reviewDecisionProps}
              reviews={store.reviews}
              sessions={store.sessions}
              loading={store.reviewsLoading}
              error={store.reviewsError}
              operationEnabled={operationEnabled}
              operationErrors={errors}
              approvalPending={approvalPending}
              delegationPending={delegationPending}
              onApproval={input => void respondApproval(input)}
              onDelegation={input => void decideDelegation(input)}
              onSession={select}
              onRefresh={store.refresh}
            />
          ) : selected ? (
            <Conversation
              session={selected}
              activity={(runId, startedAt, completedAt, status, live) => (
                <SessionActivity
                  runId={runId}
                  items={selected.activities.filter(
                    item => item.runId === runId,
                  )}
                  startedAt={startedAt}
                  completedAt={completedAt}
                  status={status}
                  live={live}
                  truncated={
                    selected.activitiesTruncated &&
                    selected.activities[0]?.runId === runId
                  }
                />
              )}
              focusTarget={sessionTarget}
              workers={workers}
              results={
                <SessionReviews
                  {...reviewDecisionProps}
                  reviews={store.reviews.filter(
                    review => review.sessionId === selected.id,
                  )}
                  allReviews={store.reviews}
                  focusedId={
                    sessionTarget.startsWith('review-')
                      ? sessionTarget.slice(7)
                      : ''
                  }
                  onSession={select}
                  onOpenDiff={openDiff}
                />
              }
              delegations={
                <Delegations
                  session={selected}
                  children={workers}
                  enabled={operationEnabled}
                  pending={delegationPending}
                  onDecision={(delegationId, decision) =>
                    selected.runId &&
                    void decideDelegation({
                      sessionId: selected.id,
                      runId: selected.runId,
                      delegationId,
                      decision,
                    })
                  }
                  onSelect={select}
                />
              }
              draft={drafts[selected.id] ?? ''}
              sending={sending}
              canSend={
                !sending &&
                !activeRun &&
                store.connection === 'ready' &&
                selectedProviderState?.status?.status === 'ready' &&
                !selectedProviderState.loading &&
                !selectedProviderState.error
              }
              approvalsEnabled={operationEnabled}
              approvalPending={approvalPending}
              onApproval={(requestId, decision) =>
                selected.runId &&
                void respondApproval({
                  sessionId: selected.id,
                  runId: selected.runId,
                  requestId,
                  decision,
                })
              }
              otherRun={
                !!activeRun &&
                activeRun.id !== selected.id &&
                selected.status !== 'running' &&
                selected.status !== 'stopping'
              }
              error={errors[selected.id] ?? ''}
              onDraft={value => changeDraft(selected.id, value)}
              onSend={() => void send()}
              onStop={() => void stop()}
            />
          ) : (
            <section
              className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center"
              aria-label="Sessions"
            >
              <h2 className="text-2xl font-medium tracking-tight">
                {store.loading
                  ? 'Loading sessions…'
                  : store.error
                    ? 'History is unavailable'
                    : 'What would you like to work on?'}
              </h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                {store.loading
                  ? 'Loading your local history.'
                  : store.error
                    ? 'Reconnect to load your saved sessions.'
                    : 'Create a session with your preferred agent.'}
              </p>
              {!store.loading && !store.error && (
                <Button onClick={openCreate}>
                  <Plus />
                  New session
                </Button>
              )}
            </section>
          )}
          {diffReview && diffTarget && (
            <Suspense
              fallback={
                <aside
                  role="status"
                  className="absolute inset-0 z-10 bg-card p-4 text-xs text-muted-foreground min-[1200px]:relative min-[1200px]:w-[46%]"
                >
                  Loading saved diff…
                </aside>
              }
            >
              <ReviewDiff
                key={`${diffReview.id}:${diffTarget.path ?? ''}`}
                review={diffReview}
                initialPath={diffTarget.path}
                onClose={closeDiff}
              />
            </Suspense>
          )}
        </main>
      </div>
      {creating && (
        <CreateSession
          open={creating}
          statuses={store.providerStates}
          onRefreshProvider={provider => void store.refreshProvider(provider)}
          onOpenChange={setCreating}
          onCreate={create}
          onReturnFocus={() => {
            if (createTrigger.current?.isConnected)
              createTrigger.current.focus();
          }}
        />
      )}
    </div>
  );
}
