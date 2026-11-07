import { useRef, useState } from 'react';
import type {
  CreateSessionInput,
  DecideDelegationInput,
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
import { SessionSidebar } from '@/widgets/session-sidebar';
import { desktopApi, useSessions } from './use-sessions';

export function Workspace() {
  const store = useSessions();
  const [selectedId, setSelectedId] = useState('');
  const [inbox, setInbox] = useState(false);
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
  const select = (id: string) => {
    setSelectedId(id);
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
  const respondApproval = async (
    requestId: string,
    decision: RespondApprovalInput['decision'],
  ) => {
    if (
      !selected?.runId ||
      selected.status !== 'running' ||
      store.connection !== 'ready' ||
      !selected.pendingApprovals.some(approval => approval.id === requestId)
    )
      return;
    const { id: sessionId, runId } = selected;
    const key = `${sessionId}/${runId}/${requestId}`;
    if (approvalRequests.current.has(key)) return;
    approvalRequests.current.add(key);
    setApprovalPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [sessionId]: '' }));
    try {
      store.merge([
        await desktopApi().respondApproval({
          sessionId,
          runId,
          requestId,
          decision,
        }),
      ]);
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
  const decideDelegation = async (
    delegationId: string,
    decision: DecideDelegationInput['decision'],
  ) => {
    if (
      !selected?.runId ||
      selected.status !== 'running' ||
      store.connection !== 'ready' ||
      !selected.delegations.some(
        delegation =>
          delegation.id === delegationId &&
          delegation.runId === selected.runId &&
          delegation.status === 'pending',
      )
    )
      return;
    const { id: sessionId, runId } = selected;
    const key = `${sessionId}/${runId}/${delegationId}`;
    if (delegationRequests.current.has(key)) return;
    delegationRequests.current.add(key);
    setDelegationPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [sessionId]: '' }));
    try {
      store.merge([
        await desktopApi().decideDelegation({
          sessionId,
          runId,
          delegationId,
          decision,
        }),
      ]);
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
  const sidebarProps = {
    sessions: store.sessions,
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
      <aside className="hidden w-56 shrink-0 md:block">
        <SessionSidebar {...sidebarProps} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card/40 md:my-2 md:mr-2 md:rounded-lg md:border">
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3 lg:px-6">
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
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">
              {inbox ? 'Do odbioru' : (selected?.title ?? 'Sesje')}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {inbox ? (
                <>
                  <Inbox className="size-3" />
                  <span>Wyniki wszystkich sesji w jednym miejscu</span>
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
            <span className="hidden text-xs text-muted-foreground sm:inline">
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
              <SheetContent className="gap-0">
                <SheetHeader>
                  <SheetTitle>Kontekst sesji</SheetTitle>
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
          <div className="max-h-48 shrink-0 space-y-2 overflow-y-auto border-b px-5 py-3 text-xs lg:px-8">
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
            <ReviewInbox />
          ) : selected ? (
            <Conversation
              session={selected}
              workers={workers}
              delegations={
                <Delegations
                  session={selected}
                  children={workers}
                  enabled={store.connection === 'ready'}
                  pending={delegationPending}
                  onDecision={(delegationId, decision) =>
                    void decideDelegation(delegationId, decision)
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
              approvalsEnabled={store.connection === 'ready'}
              approvalPending={approvalPending}
              onApproval={(requestId, decision) =>
                void respondApproval(requestId, decision)
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
              className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
              aria-label="Lista sesji"
            >
              <MessageSquare className="size-7 text-muted-foreground" />
              <h2 className="text-lg font-medium">
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
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-xs text-muted-foreground lg:px-6">
          <span>
            {selected && !inbox
              ? modeLabels[selected.mode]
              : 'Przestrzeń lokalna'}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {providers.map(provider => (
              <Button
                key={provider}
                size="sm"
                variant="ghost"
                className="h-6 px-1 text-xs text-muted-foreground"
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
