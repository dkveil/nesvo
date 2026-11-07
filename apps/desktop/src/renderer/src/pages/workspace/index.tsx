import { useRef, useState } from 'react';
import type { CreateSessionInput } from '@nesvo/contracts';
import {
  Inbox,
  Menu,
  MessageSquare,
  PanelRight,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  errorDetail,
  modelLabels,
  roleLabels,
  statusLabels,
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
  const draftVersions = useRef<Record<string, number>>({});
  const sendAttempts = useRef<
    Record<string, { text: string; messageId: string }>
  >({});
  const stopping = useRef(new Set<string>());
  const createTrigger = useRef<HTMLElement | null>(null);
  const selected =
    store.sessions.find(session => session.id === selectedId) ??
    store.sessions[0];
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
      store.claude?.status !== 'ready' ||
      store.claudeLoading ||
      store.claudeError
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
  const sidebarProps = {
    sessions: store.sessions,
    selectedId: selected?.id ?? '',
    inbox,
    onSelect: select,
    onInbox: openInbox,
    onCreate: openCreate,
  };
  const providerLabel = store.claudeLoading
    ? 'Sprawdzanie Claude Code…'
    : {
        ready: 'Claude Code jest gotowy',
        missing: 'Nie znaleziono Claude Code',
        unauthenticated: 'Claude Code wymaga logowania',
        unsupported: 'Ta wersja Claude Code nie jest obsługiwana',
        error: 'Claude Code jest niedostępny',
      }[store.claude?.status ?? 'error'];
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
                  <span>Claude Code</span>
                  <span>·</span>
                  <span>
                    {selected.actualModel ?? modelLabels[selected.model]}
                  </span>
                </>
              ) : (
                <span>Twoja lokalna przestrzeń pracy</span>
              )}
            </div>
          </div>
          {!inbox && selected && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {statusLabels[selected.status]}
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
        {(store.error ||
          store.claudeError ||
          store.claude?.status !== 'ready') && (
          <div className="shrink-0 space-y-2 border-b px-5 py-3 text-xs lg:px-8">
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
            {store.claudeError && (
              <p
                role="alert"
                className="text-destructive [overflow-wrap:anywhere]"
              >
                {store.claudeError}
              </p>
            )}
            <span role="status">{providerLabel}</span>
            {store.claude?.detail && (
              <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {store.claude.detail}
              </p>
            )}
            {store.claude?.status === 'unauthenticated' && (
              <p className="text-muted-foreground">
                Zaloguj się w terminalu poleceniem{' '}
                <code>claude auth login</code>, a następnie odśwież status.
              </p>
            )}
          </div>
        )}
        <main className="flex min-h-0 min-w-0 flex-1">
          {inbox ? (
            <ReviewInbox />
          ) : selected ? (
            <Conversation
              session={selected}
              draft={drafts[selected.id] ?? ''}
              sending={sending}
              canSend={
                !sending &&
                !activeRun &&
                store.connection === 'ready' &&
                store.claude?.status === 'ready' &&
                !store.claudeLoading &&
                !store.claudeError
              }
              otherRun={!!activeRun && activeRun.id !== selected.id}
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
                    : 'Utwórz sesję Claude Code i opisz zadanie do analizy.'}
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
          <span>Analiza · tylko odczyt</span>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1 text-xs text-muted-foreground"
              aria-label="Odśwież status Claude Code"
              title={providerLabel}
              disabled={store.claudeLoading}
              onClick={() => void store.refreshClaude()}
            >
              <RefreshCw />
              Claude Code
            </Button>
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
          models={store.claude?.models ?? []}
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
