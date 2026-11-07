import { useRef, useState } from 'react';
import { Inbox, Menu, PanelRight, Plus } from 'lucide-react';
import {
  roleLabels,
  statusLabels,
  type PreviewSession,
} from '@/entities/session';
import { CreateSession } from '@/features/create-session';
import { HostStatus } from '@/features/host-status';
import { Badge } from '@/shared/ui/badge';
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
import { demoReview, demoSessions } from './demo-data';

export function Workspace() {
  const [sessions, setSessions] = useState(demoSessions);
  const [selectedId, setSelectedId] = useState('contact-plan');
  const [inbox, setInbox] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const createTrigger = useRef<HTMLElement | null>(null);
  const selected =
    sessions.find(session => session.id === selectedId) ?? sessions[0]!;
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
  const create = (session: PreviewSession) => {
    setSessions(previous => [session, ...previous]);
    select(session.id);
  };
  const send = () => {
    const body = drafts[selected.id]?.trim();
    if (!body) return;
    setSessions(previous =>
      previous.map(session =>
        session.id === selected.id
          ? {
              ...session,
              messages: [
                ...session.messages,
                { id: crypto.randomUUID(), author: 'operator', body },
              ],
            }
          : session,
      ),
    );
    setDrafts(previous => ({ ...previous, [selected.id]: '' }));
  };
  const sidebarProps = {
    sessions,
    selectedId,
    inbox,
    onSelect: select,
    onInbox: openInbox,
    onCreate: openCreate,
  };
  const details = (
    <SessionDetails session={selected} sessions={sessions} onSelect={select} />
  );
  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background">
      <aside className="hidden w-60 shrink-0 border-r bg-muted/20 md:block">
        <SessionSidebar {...sidebarProps} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b bg-muted/20 px-4 py-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">Podgląd P1</Badge>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Dane demonstracyjne. Agenci nie są uruchomieni.
            </span>
          </div>
          <HostStatus />
        </div>
        <header className="flex min-h-20 shrink-0 items-center gap-3 border-b px-4 py-3 lg:px-6">
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
            <h1 className="truncate text-base font-semibold">
              {inbox ? 'Do odbioru' : selected.title}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {inbox ? (
                <>
                  <Inbox className="size-3" />
                  <span>Wyniki wszystkich sesji w jednym miejscu</span>
                </>
              ) : (
                <>
                  <span>{roleLabels[selected.role]}</span>
                  <span>·</span>
                  <span>{selected.provider}</span>
                  <span>·</span>
                  <span>{selected.model}</span>
                </>
              )}
            </div>
          </div>
          {!inbox && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {statusLabels[selected.status]}
            </Badge>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            className="md:hidden"
            aria-label="Nowa sesja"
            onClick={openCreate}
          >
            <Plus />
          </Button>
          {!inbox && (
            <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="xl:hidden"
                  aria-label="Pokaż szczegóły sesji"
                >
                  <PanelRight />
                </Button>
              </SheetTrigger>
              <SheetContent className="gap-0">
                <SheetHeader>
                  <SheetTitle>Kontekst sesji</SheetTitle>
                  <SheetDescription>
                    Informacje, delegacja i kontrola operatora.
                  </SheetDescription>
                </SheetHeader>
                <ScrollArea className="min-h-0 flex-1">{details}</ScrollArea>
              </SheetContent>
            </Sheet>
          )}
        </header>
        <main className="flex min-h-0 min-w-0 flex-1">
          {inbox ? (
            <ReviewInbox review={demoReview} onSession={select} />
          ) : (
            <>
              <Conversation
                session={selected}
                draft={drafts[selected.id] ?? ''}
                onDraft={value =>
                  setDrafts(previous => ({ ...previous, [selected.id]: value }))
                }
                onSend={send}
                onInbox={openInbox}
              />
              <aside
                aria-label="Panel szczegółów"
                className="hidden w-72 shrink-0 border-l xl:block"
              >
                <ScrollArea className="h-full">{details}</ScrollArea>
              </aside>
            </>
          )}
        </main>
      </div>
      {creating && (
        <CreateSession
          open={creating}
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
