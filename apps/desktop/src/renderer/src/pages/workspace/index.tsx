import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type {
  CreateSessionInput,
  DecideDelegationInput,
  DecideReviewInput,
  DesktopReview as Review,
  RespondApprovalInput,
} from '@nesvo/contracts';
import {
  ArrowLeft,
  BookOpen,
  FolderOpen,
  Menu,
  PanelRight,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  errorDetail,
  providers,
  providerStatusLabel,
  sessionRoleLabel,
  sessionStatusLabel,
} from '@/entities/session';
import { CreateSession } from '@/features/create-session';
import { HostStatus } from '@/features/host-status';
import { ManageComputers } from '@/features/manage-computers';
import { MobileAccess } from '@/features/mobile-access';
import { entityKey, hostKey } from '@/shared/lib/host-key';
import type { SelectedSkill } from '@/features/select-skill';
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
import { ProviderRail } from '@/widgets/provider-rail';
import { desktopApi, useSessions } from './use-sessions';
import { useProviderUsage } from './use-provider-usage';
import { readWorkspaceLocation, saveWorkspaceLocation } from './location';

const ReviewDiff = lazy(() => import('@/widgets/review-diff'));

const WorkspaceFiles = lazy(() => import('@/widgets/workspace-files'));

const SessionSkills = lazy(() => import('@/widgets/session-skills'));

export function Workspace() {
  const store = useSessions();
  const [location] = useState(readWorkspaceLocation);
  const [selectedId, setSelectedId] = useState(location.selectedId);
  const [inbox, setInbox] = useState(location.inbox);
  const [sessionTarget, setSessionTarget] = useState('');
  const [panel, setPanel] = useState<'diff' | 'files' | 'skills' | null>(
    location.diff ? 'diff' : null,
  );
  const [diffTarget, setDiffTarget] = useState<{
    reviewId: string;
    path?: string;
  } | null>(location.diff);
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
  const [creatingHostId, setCreatingHostId] = useState('local');
  const [computersOpen, setComputersOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedSkills, setSelectedSkills] = useState<
    Record<string, SelectedSkill | null>
  >({});
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
    Record<
      string,
      { text: string; skillId?: string; skillHash?: string; messageId: string }
    >
  >({});
  const stopping = useRef(new Set<string>());
  const createTrigger = useRef<HTMLElement | null>(null);
  const selected =
    store.sessions.find(session => entityKey(session) === selectedId) ??
    store.sessions[0];
  const selectedKey = selected ? entityKey(selected) : '';
  const selectedHostId = selected?.hostId ?? 'local';
  const selectedComputer = store.computers.find(
    computer => computer.id === selectedHostId,
  );
  const usageTerminal =
    store.sessions
      .filter(session => session.hostId === selectedHostId)
      .flatMap(session =>
        session.messages
          .filter(message => message.author === 'agent' && message.completedAt)
          .map(message => `${message.completedAt}/${message.runId}`),
      )
      .sort()
      .at(-1) ?? '';
  const usage = useProviderUsage(
    selectedHostId,
    store.hostReady(selectedHostId),
    window.nesvo ? desktopApi(selectedHostId) : undefined,
    usageTerminal,
  );
  const usageProps = {
    hostId: selectedHostId,
    computerName: selectedComputer?.name ?? 'Local',
    connected: store.hostReady(selectedHostId),
    states: usage.states,
    onRefresh: () => void usage.refresh(),
  };
  const connection = store.hostReady(selectedHostId)
    ? 'ready'
    : selectedComputer?.status === 'connecting' ||
        selectedComputer?.status === 'syncing'
      ? 'connecting'
      : 'unavailable';
  const parentSession = store.sessions.find(
    session =>
      session.id === selected?.parentId && session.hostId === selected?.hostId,
  );
  const workers = store.sessions.filter(
    session =>
      session.parentId === selected?.id && session.hostId === selected?.hostId,
  );
  const selectedProviderState = selected
    ? store.providerStates(selectedHostId)[selected.provider]
    : undefined;
  const activeRun = store.sessions.find(
    session =>
      session.hostId === selectedHostId &&
      (session.status === 'running' || session.status === 'stopping'),
  );
  const diffReview =
    !inbox && diffTarget
      ? store.reviews.find(
          review =>
            review.id === diffTarget.reviewId &&
            review.sessionId === selected?.id &&
            review.hostId === selectedHostId,
        )
      : undefined;
  const visiblePanel = panel === 'diff' && !diffReview ? null : panel;
  useEffect(() => {
    if (
      store.loading ||
      store.error ||
      store.reviewsLoading ||
      store.reviewsError
    )
      return;
    saveWorkspaceLocation({
      selectedId: selectedKey,
      inbox,
      diff: !inbox && panel === 'diff' && diffReview ? diffTarget : null,
    });
  }, [
    selectedKey,
    inbox,
    panel,
    diffReview,
    diffTarget,
    store.loading,
    store.error,
    store.reviewsLoading,
    store.reviewsError,
  ]);
  const openDiff = (reviewId: string, path?: string) => {
    diffTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDiffTarget({ reviewId, path });
    setPanel('diff');
  };
  const openFiles = () => {
    diffTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!diffReview) {
      const latest = store.reviews
        .filter(
          review =>
            review.sessionId === selected?.id &&
            review.hostId === selectedHostId,
        )
        .sort((a, b) => b.version - a.version)[0];
      setDiffTarget(latest ? { reviewId: latest.id } : null);
    }
    setPanel('files');
  };
  const closeDiff = () => {
    setPanel(null);
    setDiffTarget(null);
    const trigger = diffTrigger.current;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };
  const select = (id: string, targetId = '') => {
    setPanel(null);
    setDiffTarget(null);
    setSelectedId(id);
    setSessionTarget(targetId);
    setInbox(false);
    setNavigationOpen(false);
    setDetailsOpen(false);
  };
  const openInbox = () => {
    setPanel(null);
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
    setCreatingHostId('local');
    setCreating(true);
  };
  const create = async (input: CreateSessionInput) => {
    if (!store.hostReady(creatingHostId))
      throw new Error('Connect this computer before creating a session.');
    const session = await desktopApi(creatingHostId).createSession(input);
    store.merge([session]);
    select(entityKey(session));
    return session;
  };
  const changeDraft = (id: string, value: string) => {
    draftVersions.current[id] = (draftVersions.current[id] ?? 0) + 1;
    setDrafts(previous => ({ ...previous, [id]: value }));
  };
  const changeSkill = (id: string, skill: SelectedSkill | null) => {
    draftVersions.current[id] = (draftVersions.current[id] ?? 0) + 1;
    setSelectedSkills(previous => ({ ...previous, [id]: skill }));
  };
  const send = async () => {
    if (
      !selected ||
      sendingRef.current ||
      activeRun ||
      connection !== 'ready' ||
      selectedProviderState?.status?.status !== 'ready' ||
      selectedProviderState.loading ||
      selectedProviderState.error
    )
      return;
    const sessionId = selected.id;
    const sessionKey = entityKey(selected);
    const hostId = selected.hostId;
    const text = drafts[sessionKey]?.trim();
    if (!text || text.length > 32000) return;
    const version = draftVersions.current[sessionKey] ?? 0;
    const skillId = selectedSkills[sessionKey]?.id;
    const skillHash = selectedSkills[sessionKey]?.contentHash;
    const prior = sendAttempts.current[sessionKey];
    const attempt =
      prior?.text === text &&
      prior.skillId === skillId &&
      prior.skillHash === skillHash
        ? prior
        : { text, skillId, skillHash, messageId: crypto.randomUUID() };
    sendAttempts.current[sessionKey] = attempt;
    sendingRef.current = true;
    setSending(true);
    setErrors(previous => ({ ...previous, [sessionKey]: '' }));
    const acknowledge = () => {
      delete sendAttempts.current[sessionKey];
      if ((draftVersions.current[sessionKey] ?? 0) === version) {
        setDrafts(previous => ({ ...previous, [sessionKey]: '' }));
        setSelectedSkills(previous => ({ ...previous, [sessionKey]: null }));
      }
    };
    try {
      const session = await desktopApi(hostId).sendMessage({
        sessionId,
        messageId: attempt.messageId,
        text,
        ...(skillId ? { skillId } : {}),
        ...(skillHash ? { skillHash } : {}),
      });
      store.merge([session]);
      acknowledge();
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [sessionKey]: `Could not confirm that the message was sent. ${errorDetail(failure)}`,
      }));
      try {
        const history = await store.recover(hostId);
        if (
          history
            .find(session => session.id === sessionId)
            ?.messages.some(message => message.id === attempt.messageId)
        )
          acknowledge();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionKey]: `${previous[sessionKey] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)} You can retry the same message.`,
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
      !store.hostReady(selected.hostId) ||
      selected.status !== 'running' ||
      stopping.current.has(hostKey(selected.runId, selected.hostId))
    )
      return;
    const { id: sessionId, runId } = selected;
    const key = entityKey(selected);
    const runKey = hostKey(runId, selected.hostId);
    stopping.current.add(runKey);
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      store.merge([
        await desktopApi(selected.hostId).stopRun({ sessionId, runId }),
      ]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `Could not stop the run. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover(selected.hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [key]: `${previous[key] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
        }));
      }
    } finally {
      stopping.current.delete(runKey);
    }
  };
  const respondApproval = async (
    input: RespondApprovalInput,
    hostId = 'local',
  ) => {
    const session = store.sessions.find(
      item => item.id === input.sessionId && item.hostId === hostId,
    );
    if (
      !session ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      !store.hostReady(hostId) ||
      store.loading ||
      store.error ||
      !session.pendingApprovals.some(
        approval => approval.id === input.requestId,
      )
    )
      return;
    const { sessionId, runId, requestId } = input;
    const key = `${hostKey(sessionId, hostId)}/${runId}/${requestId}`;
    if (approvalRequests.current.has(key)) return;
    approvalRequests.current.add(key);
    setApprovalPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [hostKey(sessionId, hostId)]: '' }));
    try {
      store.merge([await desktopApi(hostId).respondApproval(input)]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [hostKey(sessionId, hostId)]:
          `Could not send the decision. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover(hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [hostKey(sessionId, hostId)]:
            `${previous[hostKey(sessionId, hostId)] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
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
  const decideDelegation = async (
    input: DecideDelegationInput,
    hostId = 'local',
  ) => {
    const session = store.sessions.find(
      item => item.id === input.sessionId && item.hostId === hostId,
    );
    if (
      !session ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      !store.hostReady(hostId) ||
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
    const key = `${hostKey(sessionId, hostId)}/${runId}/${delegationId}`;
    if (delegationRequests.current.has(key)) return;
    delegationRequests.current.add(key);
    setDelegationPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [hostKey(sessionId, hostId)]: '' }));
    try {
      store.merge([await desktopApi(hostId).decideDelegation(input)]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [hostKey(sessionId, hostId)]:
          `Could not send the worker decision. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover(hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [hostKey(sessionId, hostId)]:
            `${previous[hostKey(sessionId, hostId)] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
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
  const reviewBlockedReason = (review: Review) =>
    !store.hostReady(review.hostId)
      ? 'Connect this computer and sync its history before making a decision.'
      : store.sessions.some(
            session =>
              session.hostId === review.hostId &&
              (session.status === 'running' || session.status === 'stopping'),
          ) || sending
        ? 'Result review is available once this computer’s sessions and workers finish.'
        : '';
  const decideReview = async (
    review: Review,
    decision: DecideReviewInput['decision'],
    feedback: string,
  ) => {
    const key = entityKey(review);
    if (reviewRequests.current.has(key) || reviewBlockedReason(review)) return;
    if (
      review.status !== 'pending' ||
      (decision === 'accept' && review.diff.status === 'unavailable') ||
      (decision === 'request-changes' && !feedback.trim())
    )
      return;
    const prior = reviewAttempts.current[key];
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
    reviewAttempts.current[key] = attempt;
    reviewRequests.current.add(key);
    setReviewPending(previous => ({ ...previous, [key]: true }));
    setReviewErrors(previous => ({ ...previous, [key]: '' }));
    const acknowledge = (result: Review) => {
      store.mergeReviews([result]);
      setReviewErrors(previous => ({ ...previous, [key]: '' }));
      delete reviewAttempts.current[key];
      if (attempt.decision === 'request-changes') {
        select(hostKey(result.sessionId, result.hostId));
        void store.recover(review.hostId).catch(failure =>
          setErrors(previous => ({
            ...previous,
            [hostKey(result.sessionId, result.hostId)]:
              `The correction was requested, but the conversation could not be refreshed. ${errorDetail(failure)}`,
          })),
        );
      }
    };
    try {
      acknowledge(await desktopApi(review.hostId).decideReview(attempt));
    } catch (failure) {
      setReviewErrors(previous => ({
        ...previous,
        [key]: `Could not save the decision. ${errorDetail(failure)}`,
      }));
      try {
        const history = await store.recoverReviews(review.hostId);
        const confirmed = history.find(
          result =>
            result.id === review.id &&
            result.decision?.id === attempt.decisionId,
        );
        if (confirmed) acknowledge(confirmed);
      } catch (recoveryFailure) {
        setReviewErrors(previous => ({
          ...previous,
          [key]: `${previous[key] ?? ''} Could not refresh the results. ${errorDetail(recoveryFailure)} Retrying the same decision will not create a duplicate request.`,
        }));
      }
    } finally {
      reviewRequests.current.delete(key);
      setReviewPending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  const reviewDecisionProps = {
    blockedReason: '',
    getBlockedReason: reviewBlockedReason,
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
    connection === 'ready' && !store.loading && !store.error;
  const sidebarProps = {
    sessions: store.sessions,
    computers: store.computers,
    onComputers: () => {
      setNavigationOpen(false);
      setComputersOpen(true);
    },
    onMobile: () => {
      setNavigationOpen(false);
      setMobileOpen(true);
    },
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
    selectedId: selectedKey,
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
      <ProviderRail key={`${selectedHostId}/rail`} {...usageProps} />
      <aside className="hidden w-60 shrink-0 border-r bg-[#080808] md:block">
        <SessionSidebar {...sidebarProps} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-1.5 lg:px-5">
          <div className="md:hidden">
            <ProviderRail
              key={`${selectedHostId}/compact`}
              compact
              {...usageProps}
            />
          </div>
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
              onClick={() => select(entityKey(parentSession))}
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
          {!inbox && selected && (
            <span
              className="max-w-32 truncate text-[11px] text-muted-foreground"
              title={selectedComputer?.name}
            >
              {selectedHostId !== 'local'
                ? (selectedComputer?.name ?? 'Remote')
                : ''}
              {!store.hostReady(selectedHostId) ? ' · Offline' : ''}
            </span>
          )}
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
          {!inbox && selected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open skills"
              title="Shared library"
              aria-pressed={panel === 'skills'}
              onClick={() => {
                diffTrigger.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                setPanel('skills');
              }}
              className="text-muted-foreground"
            >
              <BookOpen className="size-4" />
            </Button>
          )}
          {!inbox && selected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open files"
              title="Workspace files"
              aria-pressed={panel === 'files'}
              onClick={openFiles}
              className="text-muted-foreground"
            >
              <FolderOpen className="size-4" />
            </Button>
          )}
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
                  Session details and computer connection.
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
                    connection={connection}
                    name={selectedComputer?.name ?? 'Local'}
                    local={selectedHostId === 'local'}
                    onRefresh={() => void store.refresh(selectedHostId)}
                  />
                  {selectedComputer?.error && (
                    <p
                      role="alert"
                      className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
                    >
                      {selectedComputer.error}
                    </p>
                  )}
                  {selectedComputer?.lastSyncedAt &&
                    !store.hostReady(selectedHostId) && (
                      <p className="text-xs leading-5 text-muted-foreground">
                        Offline snapshot · last synced{' '}
                        {new Intl.DateTimeFormat('en', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(selectedComputer.lastSyncedAt))}
                        . Work may still be running. Reconnecting will not
                        replay commands.
                      </p>
                    )}
                  {providers.map(provider => {
                    const state =
                      store.providerStates(selectedHostId)[provider];
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
                            onClick={() =>
                              void store.refreshProvider(
                                provider,
                                selectedHostId,
                              )
                            }
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
                            Sign in on{' '}
                            {selectedComputer?.name ?? 'this computer'} from its
                            terminal with{' '}
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
              operationEnabled={!store.loading && !store.error}
              computers={store.computers}
              isOperationEnabled={session => store.hostReady(session.hostId)}
              operationErrors={errors}
              approvalPending={approvalPending}
              delegationPending={delegationPending}
              onApproval={(input, hostId) =>
                void respondApproval(input, hostId)
              }
              onDelegation={(input, hostId) =>
                void decideDelegation(input, hostId)
              }
              onSession={select}
              onRefresh={store.reload}
            />
          ) : selected ? (
            <div
              className={`flex min-h-0 min-w-0 flex-1 ${visiblePanel ? 'max-[1200px]:hidden' : ''}`}
            >
              <Conversation
                key={selectedKey}
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
                    live={live && store.hostReady(selectedHostId)}
                    offline={live && !store.hostReady(selectedHostId)}
                    truncated={selected.activityTruncatedRunIds.includes(runId)}
                  />
                )}
                focusTarget={sessionTarget}
                workers={workers}
                results={
                  <SessionReviews
                    {...reviewDecisionProps}
                    reviews={store.reviews.filter(
                      review =>
                        review.sessionId === selected.id &&
                        review.hostId === selectedHostId,
                    )}
                    allReviews={store.reviews.filter(
                      review => review.hostId === selectedHostId,
                    )}
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
                      void decideDelegation(
                        {
                          sessionId: selected.id,
                          runId: selected.runId,
                          delegationId,
                          decision,
                        },
                        selectedHostId,
                      )
                    }
                    onSelect={select}
                  />
                }
                draft={drafts[selectedKey] ?? ''}
                selectedSkill={selectedSkills[selectedKey] ?? null}
                skillApi={desktopApi(selectedHostId)}
                connected={store.hostReady(selectedHostId)}
                computerName={selectedComputer?.name ?? selectedHostId}
                onSkillChange={skill => changeSkill(selectedKey, skill)}
                sending={sending}
                canSend={
                  !sending &&
                  !activeRun &&
                  connection === 'ready' &&
                  selectedProviderState?.status?.status === 'ready' &&
                  !selectedProviderState.loading &&
                  !selectedProviderState.error
                }
                approvalsEnabled={operationEnabled}
                approvalPending={approvalPending}
                onApproval={(requestId, decision) =>
                  selected.runId &&
                  void respondApproval(
                    {
                      sessionId: selected.id,
                      runId: selected.runId,
                      requestId,
                      decision,
                    },
                    selectedHostId,
                  )
                }
                otherRun={
                  !!activeRun &&
                  activeRun.id !== selected.id &&
                  selected.status !== 'running' &&
                  selected.status !== 'stopping'
                }
                error={errors[selectedKey] ?? ''}
                onDraft={value => changeDraft(selectedKey, value)}
                onSend={() => void send()}
                onStop={() => void stop()}
              />
            </div>
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
          {(panel === 'files' || panel === 'skills') &&
            !inbox &&
            selected &&
            !store.hostReady(selectedHostId) && (
              <aside className="absolute inset-0 z-10 flex flex-col gap-3 border-l bg-card p-5 text-sm min-[1200px]:relative min-[1200px]:w-96">
                <p>
                  This computer is offline. Current files and skills are
                  unavailable; saved conversations and result diffs remain
                  readable.
                </p>
                <Button variant="outline" onClick={closeDiff}>
                  Close panel
                </Button>
              </aside>
            )}
          {panel === 'diff' && diffReview && diffTarget && (
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
                key={entityKey(diffReview)}
                review={diffReview}
                selectedPath={diffTarget.path}
                onSelectPath={path =>
                  setDiffTarget({ reviewId: diffReview.id, path })
                }
                onClose={closeDiff}
                onFiles={() => setPanel('files')}
              />
            </Suspense>
          )}
          {panel === 'files' &&
            !inbox &&
            selected &&
            store.hostReady(selectedHostId) && (
              <Suspense
                fallback={
                  <aside
                    role="status"
                    className="absolute inset-0 z-10 bg-card p-4 text-xs text-muted-foreground min-[1200px]:relative min-[1200px]:w-[56%]"
                  >
                    Loading files…
                  </aside>
                }
              >
                <WorkspaceFiles
                  key={selectedKey}
                  session={selected}
                  api={desktopApi(selectedHostId)}
                  savedVersion={diffReview?.version}
                  onSavedDiff={() => setPanel('diff')}
                  onClose={closeDiff}
                />
              </Suspense>
            )}
          {panel === 'skills' &&
            !inbox &&
            selected &&
            store.hostReady(selectedHostId) && (
              <Suspense
                fallback={
                  <aside
                    role="status"
                    className="absolute inset-0 z-10 bg-card p-4 text-xs text-muted-foreground min-[1200px]:relative min-[1200px]:w-[380px]"
                  >
                    Loading skills…
                  </aside>
                }
              >
                <SessionSkills
                  key={selectedKey}
                  session={selected}
                  api={desktopApi(selectedHostId)}
                  onClose={closeDiff}
                />
              </Suspense>
            )}
        </main>
      </div>
      {computersOpen && (
        <ManageComputers
          computers={store.computers}
          api={desktopApi()}
          onOpenChange={setComputersOpen}
        />
      )}
      {mobileOpen && (
        <MobileAccess api={desktopApi()} onOpenChange={setMobileOpen} />
      )}
      {creating && (
        <CreateSession
          open={creating}
          computers={store.computers}
          hostId={creatingHostId}
          onHostChange={setCreatingHostId}
          statuses={store.providerStates(creatingHostId)}
          onRefreshProvider={provider =>
            void store.refreshProvider(provider, creatingHostId)
          }
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
