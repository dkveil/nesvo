import { useRef, useState } from 'react';
import type {
  CreateSessionInput,
  DecideDelegationInput,
  DecideReviewInput,
  Review,
  RespondApprovalInput,
} from '@nesvo/contracts';
import {
  ArrowLeft,
  Inbox,
  Menu,
  MessageSquare,
  PanelRight,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  errorDetail,
  modelLabel,
  modeLabels,
  providers,
  providerStatusLabel,
  roleLabels,
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
import { SessionReviews } from '@/widgets/session-reviews';
import { SessionSidebar } from '@/widgets/session-sidebar';
import { desktopApi, useSessions } from './use-sessions';

export function Workspace() {
  const store = useSessions();
  const [selectedId, setSelectedId] = useState('');
  const [inbox, setInbox] = useState(false);
  const [sessionTarget, setSessionTarget] = useState('');
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
  const select = (id: string, targetId = '') => {
    setSelectedId(id);
    setSessionTarget(targetId);
    setInbox(false);
    setNavigationOpen(false);
    setDetailsOpen(false);
  };
  const openInbox = () => {
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
        [sessionId]: `Nie udało się potwierdzić wysłania wiadomości. ${errorDetail(failure)}`,
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
          [sessionId]: `${previous[sessionId] ?? ''} Nie udało się odświeżyć historii. ${errorDetail(recoveryFailure)} Możesz ponowić wysyłanie tej samej wiadomości.`,
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
        [sessionId]: `Nie udało się zatrzymać uruchomienia. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionId]: `${previous[sessionId] ?? ''} Nie udało się odświeżyć historii. ${errorDetail(recoveryFailure)}`,
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
        [sessionId]: `Nie udało się przekazać decyzji. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionId]: `${previous[sessionId] ?? ''} Nie udało się odświeżyć historii. ${errorDetail(recoveryFailure)}`,
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
        [sessionId]: `Nie udało się przekazać decyzji o workerze. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionId]: `${previous[sessionId] ?? ''} Nie udało się odświeżyć historii. ${errorDetail(recoveryFailure)}`,
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
      ? 'Połącz ponownie z hostem, aby podjąć decyzję.'
      : store.loading || store.error
        ? 'Najpierw odśwież stan sesji, aby podjąć decyzję.'
        : activeRun || sending
          ? 'Poczekaj na zakończenie pracy wszystkich sesji i workerów.'
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
            [result.sessionId]: `Poprawa została zlecona, ale nie udało się odświeżyć rozmowy. ${errorDetail(failure)}`,
          })),
        );
      }
    };
    try {
      acknowledge(await desktopApi().decideReview(attempt));
    } catch (failure) {
      setReviewErrors(previous => ({
        ...previous,
        [review.id]: `Nie udało się zapisać decyzji. ${errorDetail(failure)}`,
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
          [review.id]: `${previous[review.id] ?? ''} Nie udało się odświeżyć wyników. ${errorDetail(recoveryFailure)} Ponowienie tej samej decyzji nie utworzy drugiego zlecenia.`,
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
  const noticeProviders = (selected ? [selected.provider] : providers).filter(
    provider => {
      const state = store.providerStates[provider];
      return state.error || state.status?.status !== 'ready';
    },
  );
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
                aria-label="Otwórz listę sesji"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 gap-0 p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Nawigacja</SheetTitle>
                <SheetDescription>Sesje i skrzynka odbioru.</SheetDescription>
              </SheetHeader>
              <SessionSidebar {...sidebarProps} />
            </SheetContent>
          </Sheet>
          {parentSession && !inbox && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Wróć do orkiestratora"
              title={`Wróć do: ${parentSession.title}`}
              onClick={() => select(parentSession.id)}
            >
              <ArrowLeft />
            </Button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <h1 className="min-w-0 truncate text-[13px] font-medium">
              {inbox ? 'Do decyzji' : (selected?.title ?? 'Sesje')}
            </h1>
            <div className="hidden min-w-0 items-center gap-2 truncate text-[11px] text-muted-foreground lg:flex">
              {inbox ? (
                <>
                  <Inbox className="size-3" />
                  <span>Sprawy wymagające Twojej decyzji</span>
                </>
              ) : selected ? (
                <>
                  <span>{roleLabels[selected.role]}</span>
                  <span>·</span>
                  <span>{selected.provider}</span>
                  <span>·</span>
                  <span>
                    {selected.actualModel ?? modelLabel(selected.model)}
                  </span>
                </>
              ) : (
                <span>Twoja lokalna przestrzeń pracy</span>
              )}
            </div>
          </div>
          {!inbox && selected && (
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
              {sessionStatusLabel(selected)}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Nowa sesja"
            onClick={openCreate}
          >
            <Plus />
          </Button>
          {!inbox && selected && (
            <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Pokaż szczegóły sesji"
                  title="Pokaż szczegóły sesji"
                >
                  <PanelRight />
                </Button>
              </SheetTrigger>
              <SheetContent className="gap-0 bg-card">
                <SheetHeader className="border-b px-5 py-4">
                  <SheetTitle className="text-sm">Kontekst sesji</SheetTitle>
                  <SheetDescription>
                    Informacje o sesji i zakresie analizy.
                  </SheetDescription>
                </SheetHeader>
                <ScrollArea className="min-h-0 flex-1">
                  <SessionDetails session={selected} />
                </ScrollArea>
              </SheetContent>
            </Sheet>
          )}
        </header>
        {(store.error || noticeProviders.length > 0) && (
          <div className="max-h-40 shrink-0 space-y-2 overflow-y-auto border-b bg-card/50 px-5 py-3 text-xs lg:px-8">
            {store.error && (
              <div role="alert" className="space-y-2">
                <p className="leading-relaxed text-destructive [overflow-wrap:anywhere]">
                  {store.error}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.location.reload()}
                >
                  Odśwież okno
                </Button>
              </div>
            )}
            {noticeProviders.map(provider => {
              const state = store.providerStates[provider];
              return (
                <div key={provider} className="space-y-2">
                  {state.error && (
                    <p
                      role="alert"
                      className="text-destructive [overflow-wrap:anywhere]"
                    >
                      {state.error}
                    </p>
                  )}
                  <span role="status">
                    {providerStatusLabel(provider, state)}
                  </span>
                  {state.status?.detail && (
                    <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                      {state.status.detail}
                    </p>
                  )}
                  {state.status?.status === 'unauthenticated' && (
                    <p className="text-muted-foreground">
                      Zaloguj się w terminalu poleceniem{' '}
                      <code>
                        {provider === 'Claude Code'
                          ? 'claude auth login'
                          : 'codex login'}
                      </code>
                      , a następnie odśwież status.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <main className="flex min-h-0 min-w-0 flex-1">
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
              aria-label="Lista sesji"
            >
              <MessageSquare className="mb-1 size-5 text-muted-foreground" />
              <h2 className="text-2xl font-medium tracking-tight">
                {store.loading
                  ? 'Wczytywanie sesji…'
                  : store.error
                    ? 'Historia jest niedostępna'
                    : 'Zacznij nową rozmowę'}
              </h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                {store.loading
                  ? 'Odczytujemy lokalną historię.'
                  : store.error
                    ? 'Odśwież połączenie, aby ponowić odczyt zapisanych sesji.'
                    : 'Wybierz providera, utwórz sesję i opisz zadanie.'}
              </p>
              {!store.loading && !store.error && (
                <Button onClick={openCreate}>
                  <Plus />
                  Nowa sesja
                </Button>
              )}
            </section>
          )}
        </main>
        <footer className="flex min-h-7 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border/60 px-4 py-0.5 text-[10px] text-muted-foreground lg:px-5">
          <span>
            {selected && !inbox
              ? modeLabels[selected.mode]
              : 'Przestrzeń lokalna'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {providers.map(provider => (
              <Button
                key={provider}
                size="sm"
                variant="ghost"
                className="h-5 gap-1 px-1 text-[10px] text-muted-foreground [&_svg]:size-3"
                aria-label={`Odśwież status ${provider}`}
                title={providerStatusLabel(
                  provider,
                  store.providerStates[provider],
                )}
                disabled={store.providerStates[provider].loading}
                onClick={() => void store.refreshProvider(provider)}
              >
                <RefreshCw />
                {provider}
              </Button>
            ))}
            <HostStatus
              connection={store.connection}
              onRefresh={store.refresh}
            />
          </div>
        </footer>
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
