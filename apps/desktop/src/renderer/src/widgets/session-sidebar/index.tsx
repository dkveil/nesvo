import { useState } from 'react';
import {
  CornerDownRight,
  GitBranch,
  Inbox,
  MessageSquare,
  Plus,
  Search,
} from 'lucide-react';
import {
  sessionRoleLabel,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { ScrollArea } from '@/shared/ui/scroll-area';

type Props = {
  sessions: Session[];
  pendingActions: number;
  selectedId: string;
  inbox: boolean;
  onSelect: (id: string) => void;
  onInbox: () => void;
  onCreate: () => void;
};

export function SessionSidebar({
  sessions,
  pendingActions,
  selectedId,
  inbox,
  onSelect,
  onInbox,
  onCreate,
}: Props) {
  const [search, setSearch] = useState('');
  const matches = (session: Session) =>
    session.title
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  const roots = sessions.filter(
    session =>
      !session.parentId ||
      !sessions.some(parent => parent.id === session.parentId),
  );
  const filtered = roots.filter(
    root =>
      matches(root) ||
      sessions.some(child => child.parentId === root.id && matches(child)),
  );
  const row = (session: Session, child = false) => (
    <Button
      key={session.id}
      variant={!inbox && selectedId === session.id ? 'secondary' : 'ghost'}
      title={`${session.provider} · ${sessionRoleLabel(session) || 'Session'} · ${sessionStatusLabel(session)}`}
      className={`grid h-8 w-full grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-2.5 overflow-hidden py-1 text-left text-[13px] font-normal ${child ? 'pr-3 pl-5' : 'pr-3 pl-2'}`}
      onClick={() => onSelect(session.id)}
      aria-current={!inbox && selectedId === session.id ? 'page' : undefined}
    >
      {child ? (
        <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
      ) : sessionRoleLabel(session) === 'Orchestrator' ? (
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
        {session.status === 'ready' ? '' : sessionStatusLabel(session)}
      </span>
    </Button>
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#080808]">
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <span className="text-[13px] font-semibold tracking-tight">Nesvo</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 text-muted-foreground"
          aria-label="New session"
          title="New session"
          onClick={onCreate}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="space-y-2 px-2.5 pt-2 pb-5">
        <Button
          variant={inbox ? 'secondary' : 'ghost'}
          className="h-8 w-full justify-start gap-2 px-2 text-[13px] font-normal"
          onClick={onInbox}
          aria-current={inbox ? 'page' : undefined}
        >
          <Inbox className="size-3.5 text-muted-foreground" />
          Inbox
          {pendingActions > 0 && (
            <span
              aria-label={`${pendingActions} pending items`}
              className="ml-auto text-xs tabular-nums text-muted-foreground"
            >
              {pendingActions}
            </span>
          )}
        </Button>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Search sessions"
            placeholder="Search sessions…"
            className="h-8 border-transparent bg-transparent pl-7 text-xs shadow-none placeholder:text-muted-foreground/80 focus-visible:border-input focus-visible:ring-1 dark:bg-transparent"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Sessions" className="space-y-1 px-2.5 pb-4">
          <p className="px-2 pb-2 text-[11px] font-medium text-muted-foreground">
            Sessions
          </p>
          {filtered.map(root => (
            <div key={root.id} className="space-y-0.5">
              {row(root)}
              {sessions
                .filter(
                  child =>
                    child.parentId === root.id &&
                    (matches(root) || matches(child)),
                )
                .sort(
                  (a, b) =>
                    a.createdAt.localeCompare(b.createdAt) ||
                    a.id.localeCompare(b.id),
                )
                .map(child => row(child, true))}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-sm text-muted-foreground">
              {search ? 'No matching sessions.' : 'No sessions yet.'}
            </p>
          )}
        </nav>
      </ScrollArea>
    </div>
  );
}
