import { useState, type ReactNode, type RefObject } from 'react';
import {
  ChevronDown,
  CircleCheck,
  CornerDownRight,
  Inbox,
  Monitor,
  PanelLeftClose,
  Search,
  Smartphone,
  SquarePen,
  X,
} from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from 'cn';
import { entityKey } from '@/shared/lib/host-key';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import {
  directoryLabel,
  sessionRoleLabel,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';

type Props = {
  sessions: Session[];
  computers: Computer[];
  onComputers: () => void;
  onMobile: () => void;
  pendingActions: number;
  selectedId: string;
  inbox: boolean;
  onSelect: (id: string) => void;
  onInbox: () => void;
  onCreate: () => void;
  onCollapse?: () => void;
  collapseToggleRef?: RefObject<HTMLButtonElement | null>;
  usage?: ReactNode;
  footerStart?: ReactNode;
};

const statusTone: Partial<Record<Session['status'], string>> = {
  running: 'text-info-foreground',
  stopping: 'text-info-foreground',
  completed: 'text-success-foreground',
  failed: 'text-error-foreground',
};

function initials(label: string) {
  const words = label.split(/[\s\-_.]+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
      : label.slice(0, 2);
  return letters.toLocaleUpperCase();
}

function SessionStatus({
  session,
  offline,
  now,
}: {
  session: Session;
  offline: boolean;
  now: number;
}) {
  if (offline)
    return <span className="text-sidebar-muted-foreground">Offline</span>;
  if (session.status === 'ready')
    return (
      <time
        dateTime={session.updatedAt}
        className="text-sidebar-muted-foreground"
      >
        {formatRelativeTime(session.updatedAt, now)}
      </time>
    );
  const label = sessionStatusLabel(session);
  const tone =
    label === 'Needs approval'
      ? 'text-warning-foreground'
      : (statusTone[session.status] ?? 'text-sidebar-muted-foreground');
  return (
    <span className={cn('inline-flex items-center gap-1', tone)}>
      {session.status === 'completed' && (
        <CircleCheck className="size-3" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

export function SessionSidebar({
  sessions,
  computers,
  onComputers,
  onMobile,
  pendingActions,
  selectedId,
  inbox,
  onSelect,
  onInbox,
  onCreate,
  onCollapse,
  collapseToggleRef,
  usage,
  footerStart,
}: Props) {
  const [search, setSearch] = useState('');
  const [closedHosts, setClosedHosts] = useState<string[]>([]);
  const now = useNow(60_000);
  const computerOf = (session: Session) =>
    computers.find(item => item.id === session.hostId);
  const matches = (session: Session) =>
    `${session.title} ${directoryLabel(session.directory)} ${computerOf(session)?.name ?? ''}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  const childrenOf = (root: Session) =>
    sessions
      .filter(
        child => child.parentId === root.id && child.hostId === root.hostId,
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  const roots = sessions.filter(
    session =>
      !session.parentId ||
      !sessions.some(
        parent =>
          parent.id === session.parentId && parent.hostId === session.hostId,
      ),
  );
  const filtered = roots.filter(
    root => matches(root) || childrenOf(root).some(matches),
  );
  const groups = computers
    .map(computer => ({
      computer,
      roots: filtered.filter(root => root.hostId === computer.id),
    }))
    .filter(group => group.roots.length > 0);
  const grouped = computers.length > 1;
  const row = (session: Session, child = false) => {
    const computer = computerOf(session);
    const selected = !inbox && selectedId === entityKey(session);
    const offline = computer?.status !== 'connected';
    const directory = directoryLabel(session.directory);
    const role = sessionRoleLabel(session);
    return (
      <li key={entityKey(session)}>
        <button
          type="button"
          data-host-id={session.hostId}
          data-session-id={session.id}
          aria-current={selected ? 'page' : undefined}
          aria-label={`${session.title} · ${directory} · ${offline ? 'Offline' : sessionStatusLabel(session)}`}
          title={`${computer?.name ?? session.hostId} · ${session.provider} · ${role || 'Session'} · ${sessionStatusLabel(session)}`}
          onClick={() => onSelect(entityKey(session))}
          className={cn(
            'flex w-full flex-col rounded-(--control-radius) py-(--sidebar-inset) pr-(--sidebar-row-inset) text-left transition-colors duration-100 outline-none',
            'hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            child ? 'pl-5' : 'pl-(--sidebar-row-inset)',
            selected && 'bg-sidebar-row-selected',
          )}
        >
          <span className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-sidebar-muted-foreground">
            {child ? (
              <CornerDownRight
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <span
                aria-hidden="true"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-secondary text-[9px] leading-none font-semibold text-secondary-foreground"
              >
                {initials(directory)}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{directory}</span>
            <span className="shrink-0 text-xs tabular-nums">
              <SessionStatus session={session} offline={offline} now={now} />
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[13px] font-medium">
            {session.title}
          </span>
          <span className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-2xs text-sidebar-muted-foreground">
            <span className="truncate">{session.provider}</span>
            {role && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{role}</span>
              </>
            )}
            {!grouped && session.hostId !== 'local' && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{computer?.name ?? 'Remote'}</span>
              </>
            )}
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="drag-region flex h-(--shell-topbar-height) shrink-0 items-center gap-1.5 pr-2 pl-[calc(0.5rem+var(--titlebar-inset-left))]">
        {onCollapse && (
          <Button
            ref={collapseToggleRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-sidebar-muted-foreground"
            aria-label="Toggle sidebar"
            aria-pressed="true"
            title="Collapse sidebar (Ctrl+B)"
            onClick={onCollapse}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        )}
        <span
          className={cn(
            'text-[13px] font-semibold tracking-tight select-none',
            !onCollapse && 'pl-1',
          )}
        >
          Nesvo
        </span>
      </div>
      <div className="space-y-1 px-2 pb-2">
        <div className="flex items-center gap-1">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-(--control-radius) px-2 text-sidebar-muted-foreground transition-colors duration-100 focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-ring/70 focus-within:ring-inset hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <input
              type="text"
              aria-label="Search sessions"
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
              value={search}
              onChange={event => setSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape' && search) {
                  event.preventDefault();
                  setSearch('');
                }
              }}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setSearch('')}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-sidebar-muted-foreground"
            aria-label="New session"
            title="New session"
            onClick={onCreate}
          >
            <SquarePen className="size-4" />
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            'h-7 w-full justify-start gap-2 rounded-(--control-radius) px-2 text-[13px] font-normal hover:bg-sidebar-row-hover',
            inbox && 'bg-sidebar-row-selected',
          )}
          onClick={onInbox}
          aria-current={inbox ? 'page' : undefined}
        >
          <Inbox className="size-4 text-sidebar-muted-foreground" />
          Inbox
          {pendingActions > 0 && (
            <span
              aria-label={`${pendingActions} pending items`}
              className="ml-auto text-xs text-sidebar-muted-foreground tabular-nums"
            >
              {pendingActions}
            </span>
          )}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <nav aria-label="Sessions" className="space-y-1 px-2 pb-3">
          {groups.map(({ computer, roots }) => {
            const closed = grouped && closedHosts.includes(computer.id);
            return (
              <section key={computer.id} aria-label={computer.name}>
                {grouped && (
                  <button
                    type="button"
                    aria-expanded={!closed}
                    className="flex h-8 w-full items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() =>
                      setClosedHosts(previous =>
                        closed
                          ? previous.filter(id => id !== computer.id)
                          : [...previous, computer.id],
                      )
                    }
                  >
                    <Monitor
                      className="size-3.5 shrink-0 text-sidebar-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {computer.name}
                    </span>
                    {computer.status !== 'connected' && (
                      <span className="text-2xs text-sidebar-muted-foreground">
                        Offline
                      </span>
                    )}
                    {closed && (
                      <span className="text-xs text-sidebar-muted-foreground tabular-nums">
                        {roots.length}
                      </span>
                    )}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        'size-3 shrink-0 text-sidebar-muted-foreground transition-transform duration-150',
                        closed && '-rotate-90',
                      )}
                    />
                  </button>
                )}
                {!closed && (
                  <ul className="flex flex-col gap-px">
                    {roots.flatMap(root => [
                      row(root),
                      ...childrenOf(root)
                        .filter(child => matches(root) || matches(child))
                        .map(child => row(child, true)),
                    ])}
                  </ul>
                )}
              </section>
            );
          })}
          {groups.length === 0 && (
            <p className="px-2 py-6 text-sm text-sidebar-muted-foreground">
              {search ? 'No matching sessions.' : 'No sessions yet.'}
            </p>
          )}
        </nav>
      </div>
      {usage && (
        <section
          aria-label="Usage"
          className="shrink-0 border-t border-sidebar-border px-2 pt-2 pb-1.5"
        >
          <h2 className="px-(--sidebar-row-inset) pb-1 text-2xs font-medium text-sidebar-muted-foreground">
            Usage
          </h2>
          {usage}
        </section>
      )}
      <div className="flex shrink-0 items-center gap-0.5 border-t border-sidebar-border px-2 py-1.5">
        {footerStart}
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 text-sidebar-muted-foreground"
          aria-label="Computers"
          title="Computers"
          onClick={onComputers}
        >
          <Monitor className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 text-sidebar-muted-foreground"
          aria-label="Phone access"
          title="Phone access"
          onClick={onMobile}
        >
          <Smartphone className="size-4" />
        </Button>
      </div>
    </div>
  );
}
