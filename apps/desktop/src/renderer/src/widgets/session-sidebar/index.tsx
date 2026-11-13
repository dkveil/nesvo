import { useState, type ReactNode, type RefObject } from 'react';
import {
  ChevronDown,
  CircleCheck,
  Cloud,
  CornerDownRight,
  Inbox,
  Monitor,
  PanelLeft,
  Search,
  Settings,
  SquarePen,
  Workflow,
  X,
} from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from 'cn';
import { entityKey } from '@/shared/lib/host-key';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import {
  directoryLabel,
  ProviderGlyph,
  sessionRoleLabel,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import {
  runStatusLabel,
  runStatusTones,
  showsRunStatus,
  toneText,
  type PipelineRun,
} from '@/entities/pipeline';
import { Button } from '@/shared/ui/button';
import { ProjectChip } from '@/shared/ui/project-chip';

type Props = {
  sessions: Session[];
  pipelineRuns: PipelineRun[];
  computers: Computer[];
  hostName: string;
  onComputers: () => void;
  onSettings: () => void;
  pendingActions: number;
  selectedId: string;
  inbox: boolean;
  pipelines: boolean;
  onSelect: (id: string) => void;
  onInbox: () => void;
  onPipelines: () => void;
  onCreate: () => void;
  onCollapse?: () => void;
  collapseToggleRef?: RefObject<HTMLButtonElement | null>;
  footerStart?: ReactNode;
};

const statusTone: Partial<Record<Session['status'], string>> = {
  running: 'text-info-foreground',
  stopping: 'text-info-foreground',
  completed: 'text-success-foreground',
  failed: 'text-error-foreground',
};

function SessionStatus({
  session,
  run,
  offline,
  now,
}: {
  session: Session;
  run: PipelineRun | undefined;
  offline: boolean;
  now: number;
}) {
  if (offline)
    return <span className="text-sidebar-muted-foreground">Offline</span>;
  if (showsRunStatus(session, run))
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 font-medium',
          toneText[runStatusTones[run.status]],
        )}
      >
        <Workflow className="size-3" aria-hidden="true" />
        {runStatusLabel(run.status)}
      </span>
    );
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
    <span className={cn('inline-flex items-center gap-1 font-medium', tone)}>
      {session.status === 'completed' && (
        <CircleCheck className="size-3" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

export function SessionSidebar({
  sessions,
  pipelineRuns,
  computers,
  hostName,
  onComputers,
  onSettings,
  pendingActions,
  selectedId,
  inbox,
  pipelines,
  onSelect,
  onInbox,
  onPipelines,
  onCreate,
  onCollapse,
  collapseToggleRef,
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
  const runOf = (session: Session) =>
    session.pipelineRunId
      ? pipelineRuns.find(
          run =>
            run.id === session.pipelineRunId && run.hostId === session.hostId,
        )
      : undefined;
  const parentIdOf = (session: Session) =>
    session.parentId ??
    (session.pipelineStepId ? (runOf(session)?.sessionId ?? null) : null);
  const statusText = (session: Session) => {
    const run = runOf(session);
    return showsRunStatus(session, run)
      ? `Pipeline ${runStatusLabel(run.status)}`
      : sessionStatusLabel(session);
  };
  const childrenOf = (root: Session) =>
    sessions
      .filter(
        child =>
          child.id !== root.id &&
          parentIdOf(child) === root.id &&
          child.hostId === root.hostId,
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  const roots = sessions.filter(session => {
    const parentId = parentIdOf(session);
    return (
      !parentId ||
      parentId === session.id ||
      !sessions.some(
        parent => parent.id === parentId && parent.hostId === session.hostId,
      )
    );
  });
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
    const selected = !inbox && !pipelines && selectedId === entityKey(session);
    const offline = computer?.status !== 'connected';
    const directory = directoryLabel(session.directory);
    const role = sessionRoleLabel(session);
    const remote = session.hostId !== 'local';
    return (
      <li key={entityKey(session)}>
        <button
          type="button"
          data-host-id={session.hostId}
          data-session-id={session.id}
          aria-current={selected ? 'page' : undefined}
          aria-label={`${session.title} · ${directory} · ${offline ? 'Offline' : statusText(session)}`}
          title={`${computer?.name ?? session.hostId} · ${session.provider} · ${role || 'Session'} · ${statusText(session)}`}
          onClick={() => onSelect(entityKey(session))}
          className={cn(
            'flex w-full flex-col rounded-lg py-2 pr-(--sidebar-row-inset) text-left transition-colors duration-100 outline-none',
            'hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            child ? 'pl-5' : 'pl-(--sidebar-row-inset)',
            selected &&
              'bg-sidebar-row-selected shadow-(--sidebar-row-selected-shadow) hover:bg-sidebar-row-selected',
          )}
        >
          <span className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-sidebar-muted-foreground">
            {child ? (
              <CornerDownRight
                className="size-3.5 shrink-0 text-sidebar-icon"
                aria-hidden="true"
              />
            ) : (
              <ProjectChip label={directory} />
            )}
            <span className="min-w-0 flex-1 truncate">{directory}</span>
            <span className="shrink-0 text-xs tabular-nums">
              <SessionStatus
                session={session}
                run={runOf(session)}
                offline={offline}
                now={now}
              />
            </span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sidebar-foreground">
              {session.title}
            </span>
            {remote && !grouped && (
              <Cloud
                className="size-3.5 shrink-0 text-sidebar-icon"
                aria-hidden="true"
              />
            )}
            <ProviderGlyph provider={session.provider} />
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
            className="size-7 text-sidebar-icon hover:text-sidebar-foreground"
            aria-label="Toggle sidebar"
            aria-pressed="true"
            title="Collapse sidebar (Ctrl+B)"
            onClick={onCollapse}
          >
            <PanelLeft className="size-4" />
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
      <div className="space-y-0.5 px-(--sidebar-inset) pb-2">
        <div className="flex items-center gap-0.5">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground transition-colors duration-100 focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-ring/70 focus-within:ring-inset hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <Search
              className="size-4 shrink-0 text-sidebar-icon"
              aria-hidden="true"
            />
            <input
              type="text"
              aria-label="Search sessions"
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
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
            className="size-7 text-sidebar-icon hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            aria-label="New session"
            title="New session"
            onClick={onCreate}
          >
            <SquarePen className="size-4" />
          </Button>
        </div>
        <button
          type="button"
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground transition-colors duration-100 outline-none',
            'hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            inbox && 'bg-sidebar-row-selected text-sidebar-foreground',
          )}
          onClick={onInbox}
          aria-current={inbox ? 'page' : undefined}
        >
          <Inbox className="size-4 text-sidebar-icon" aria-hidden="true" />
          Inbox
          {pendingActions > 0 && (
            <span
              aria-label={`${pendingActions} pending items`}
              className="ml-auto text-xs text-sidebar-muted-foreground tabular-nums"
            >
              {pendingActions}
            </span>
          )}
        </button>
        <button
          type="button"
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground transition-colors duration-100 outline-none',
            'hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            pipelines && 'bg-sidebar-row-selected text-sidebar-foreground',
          )}
          onClick={onPipelines}
          aria-current={pipelines ? 'page' : undefined}
        >
          <Workflow className="size-4 text-sidebar-icon" aria-hidden="true" />
          Pipelines
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <nav
          aria-label="Sessions"
          className="space-y-1 px-(--sidebar-inset) pb-3"
        >
          {groups.map(({ computer, roots }) => {
            const closed = grouped && closedHosts.includes(computer.id);
            return (
              <section key={computer.id} aria-label={computer.name}>
                {grouped && (
                  <button
                    type="button"
                    aria-expanded={!closed}
                    className="flex h-7 w-full items-center gap-2 rounded-md px-(--sidebar-row-inset) text-left text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() =>
                      setClosedHosts(previous =>
                        closed
                          ? previous.filter(id => id !== computer.id)
                          : [...previous, computer.id],
                      )
                    }
                  >
                    {computer.id === 'local' ? (
                      <Monitor
                        className="size-3.5 shrink-0 text-sidebar-icon"
                        aria-hidden="true"
                      />
                    ) : (
                      <Cloud
                        className="size-3.5 shrink-0 text-sidebar-icon"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {computer.name}
                    </span>
                    {computer.status !== 'connected' && (
                      <span className="text-2xs">Offline</span>
                    )}
                    {closed && (
                      <span className="text-xs tabular-nums">
                        {roots.length}
                      </span>
                    )}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        'size-3 shrink-0 text-sidebar-icon transition-transform duration-150',
                        closed && '-rotate-90',
                      )}
                    />
                  </button>
                )}
                {!closed && (
                  <ul className="flex flex-col gap-0.5">
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
      <div className="flex h-10 shrink-0 items-center gap-0.5 px-(--sidebar-inset)">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 text-sidebar-icon hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          aria-label="Settings"
          title="Settings"
          onClick={onSettings}
        >
          <Settings className="size-4" />
        </Button>
        {footerStart}
        <div className="min-w-0 flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 max-w-28 min-w-0 shrink gap-1.5 px-2 text-xs font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          aria-label="Computers"
          title={`Computers · ${hostName}`}
          onClick={onComputers}
        >
          <Monitor className="size-3.5 text-sidebar-icon" />
          <span className="truncate">{hostName}</span>
        </Button>
      </div>
    </div>
  );
}
