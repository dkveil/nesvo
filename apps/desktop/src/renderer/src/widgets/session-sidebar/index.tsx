import { useState } from 'react';
import {
  GitBranch,
  Inbox,
  MessageSquare,
  Plus,
  Search,
  CornerDownRight,
} from 'lucide-react';
import { statusLabels, type PreviewSession } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { ScrollArea } from '@/shared/ui/scroll-area';

type Props = {
  sessions: PreviewSession[];
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
  const matches = (session: PreviewSession) =>
    session.title
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  const roots = sessions.filter(
    session =>
      !session.parentId &&
      (matches(session) ||
        sessions.some(
          child => child.parentId === session.id && matches(child),
        )),
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
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            1
          </span>
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
          {roots.map(root => (
            <div key={root.id} className="mb-2">
              <Button
                variant={
                  !inbox && selectedId === root.id ? 'secondary' : 'ghost'
                }
                className="h-auto w-full justify-start px-2 py-2 text-left font-normal"
                onClick={() => onSelect(root.id)}
                aria-current={
                  !inbox && selectedId === root.id ? 'page' : undefined
                }
              >
                {root.role === 'orchestrator' ? (
                  <GitBranch className="text-muted-foreground" />
                ) : (
                  <MessageSquare className="text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{root.title}</span>
                  <span className="block pt-0.5 text-xs font-normal text-muted-foreground">
                    {root.provider}
                  </span>
                </span>
              </Button>
              {sessions
                .filter(
                  child =>
                    child.parentId === root.id &&
                    (matches(root) || matches(child)),
                )
                .map(child => (
                  <Button
                    key={child.id}
                    variant={
                      !inbox && selectedId === child.id ? 'secondary' : 'ghost'
                    }
                    className="mt-0.5 h-auto w-full justify-start py-2 pr-2 pl-4 text-left font-normal"
                    onClick={() => onSelect(child.id)}
                    aria-current={
                      !inbox && selectedId === child.id ? 'page' : undefined
                    }
                  >
                    <CornerDownRight className="text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-xs">
                        {child.title}
                      </span>
                      <span className="block pt-0.5 text-xs text-muted-foreground">
                        {statusLabels[child.status]}
                      </span>
                    </span>
                  </Button>
                ))}
            </div>
          ))}
          {roots.length === 0 && (
            <p className="px-2 py-6 text-sm text-muted-foreground">
              Brak pasujących sesji.
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
