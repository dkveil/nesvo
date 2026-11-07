import { useState } from 'react';
import { GitBranch, Inbox, MessageSquare, Plus, Search } from 'lucide-react';
import { statusLabels, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { ScrollArea } from '@/shared/ui/scroll-area';

type Props = {
  sessions: Session[];
  selectedId: string;
  inbox: boolean;
  onSelect: (id: string) => void;
  onInbox: () => void;
  onCreate: () => void;
};

export function SessionSidebar({
  sessions,
  selectedId,
  inbox,
  onSelect,
  onInbox,
  onCreate,
}: Props) {
  const [search, setSearch] = useState('');
  const filtered = sessions.filter(session =>
    session.title
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <span className="text-sm font-semibold">Nesvo</span>
      </div>
      <div className="space-y-1 px-3 pb-5">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={onCreate}
        >
          <Plus />
          Nowa sesja
        </Button>
        <Button
          variant={inbox ? 'secondary' : 'ghost'}
          className="w-full justify-start"
          onClick={onInbox}
          aria-current={inbox ? 'page' : undefined}
        >
          <Inbox />
          Do odbioru
        </Button>
        <div className="relative mt-3">
          <Search
            className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Szukaj sesji"
            placeholder="Szukaj sesji…"
            className="border-transparent pl-9 shadow-none dark:bg-transparent"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Sesje" className="space-y-1 px-3 pb-4">
          <p className="px-2 pb-2 text-xs font-medium text-muted-foreground">
            Sesje
          </p>
          {filtered.map(session => (
            <Button
              key={session.id}
              variant={
                !inbox && selectedId === session.id ? 'secondary' : 'ghost'
              }
              className="h-auto w-full justify-start px-2 py-2 text-left font-normal"
              onClick={() => onSelect(session.id)}
              aria-current={
                !inbox && selectedId === session.id ? 'page' : undefined
              }
            >
              {session.role === 'orchestrator' ? (
                <GitBranch className="text-muted-foreground" />
              ) : (
                <MessageSquare className="text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{session.title}</span>
                <span className="block pt-0.5 text-xs font-normal text-muted-foreground">
                  {session.provider} ·{' '}
                  {session.pendingApprovals.length > 0 &&
                  session.status === 'running'
                    ? 'Czeka na zgodę'
                    : statusLabels[session.status]}
                </span>
              </span>
            </Button>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-sm text-muted-foreground">
              {search ? 'Brak pasujących sesji.' : 'Brak zapisanych sesji.'}
            </p>
          )}
        </nav>
      </ScrollArea>
      <p className="px-5 py-4 text-xs text-muted-foreground">
        Przestrzeń lokalna
      </p>
    </div>
  );
}
