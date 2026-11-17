import { useState, type ReactNode, type RefObject } from 'react';
import {
  CalendarClock,
  ChevronDown,
  CircleCheck,
  Cloud,
  CornerDownRight,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Inbox,
  Monitor,
  PanelLeft,
  Pin,
  Search,
  Settings,
  SquarePen,
  Workflow,
  X,
} from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { entityKey } from '@/shared/lib/host-key';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import {
  directoryLabel,
  ProviderGlyph,
  sessionRoleLabel,
  sessionStatusLabel,
  statusTones,
  type Session,
} from '@/entities/session';
import {
  runStatusLabel,
  runStatusTones,
  showsRunStatus,
  toneText,
  type WorkflowRun,
} from '@/entities/workflow';
import type { ScheduledJob } from '@/entities/scheduled-job';
import { BrandWordmark } from '@/shared/ui/brand-wordmark';
import { Button } from '@/shared/ui/button';
import { ProjectChip } from '@/shared/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { dropIndicatorClass } from './drop-indicator';
import { GroupedSessions } from './grouped-sessions';
import type { RowDecoration, SidebarHousekeeping } from './housekeeping';
import { GROUP_INDENT_REM } from './session-tree';
import { useCollapsedGroups } from './use-collapsed-groups';
import { useSessionBranches, type ReadBranch } from './use-session-branches';

export type { SidebarHousekeeping } from './housekeeping';

type Props = {
  sessions: Session[];
  workflowRuns: WorkflowRun[];
  computers: Computer[];
  hostName: string;
  onComputers: () => void;
  onSettings: () => void;
  pendingActions: number;
  selectedId: string;
  unreadKeys?: Set<string>;
  inbox: boolean;
  workflows: boolean;
  onSelect: (id: string) => void;
  onSearchHistory: (query: string) => void;
  onInbox: () => void;
  onWorkflows: () => void;
  onCreate: () => void;
  onCollapse?: () => void;
  collapseToggleRef?: RefObject<HTMLButtonElement | null>;
  footerStart?: ReactNode;
  scheduledJobs?: ScheduledJob[];
  automations?: boolean;
  automationsAvailable?: boolean;
  onAutomations?: () => void;
  pullRequests?: boolean;
  onPullRequests?: () => void;
  navigation?: 'inline' | 'rail';
  readBranch?: ReadBranch;
  housekeeping?: SidebarHousekeeping;
  currentHostId?: string;
};

const navButtonClass =
  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground transition-colors duration-100 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset';

function SessionStatus({
  session,
  run,
  offline,
  now,
}: {
  session: Session;
  run: WorkflowRun | undefined;
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
  const sessionTone = statusTones[session.status];
  const tone =
    label === 'Needs approval'
      ? toneText.warning
      : sessionTone
        ? toneText[sessionTone]
        : 'text-sidebar-muted-foreground';
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium', tone)}>
      {session.status === 'completed' && (
        <CircleCheck className="size-3" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

function MetaSeparator() {
  return (
    <span aria-hidden="true" className="shrink-0 text-sidebar-icon">
      ·
    </span>
  );
}

export function SessionSidebar({
  sessions,
  workflowRuns,
  computers,
  hostName,
  onComputers,
  onSettings,
  pendingActions,
  selectedId,
  unreadKeys,
  inbox,
  workflows,
  onSelect,
  onSearchHistory,
  onInbox,
  onWorkflows,
  onCreate,
  onCollapse,
  collapseToggleRef,
  footerStart,
  scheduledJobs = [],
  automations = false,
  automationsAvailable = false,
  onAutomations,
  pullRequests = false,
  onPullRequests,
  navigation = 'inline',
  readBranch,
  housekeeping,
  currentHostId = 'local',
}: Props) {
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [archivedHosts, setArchivedHosts] = useState<string[]>([]);
  const collapsed = useCollapsedGroups();
  const organized = (hostId: string) => !!housekeeping?.supports(hostId);
  const hidesArchived = (session: Session) =>
    organized(session.hostId) &&
    !!session.archivedAt &&
    !archivedHosts.includes(session.hostId);
  const [closedHosts, setClosedHosts] = useState<string[]>([]);
  const [jobToggles, setJobToggles] = useState<Record<string, boolean>>({});
  const [childToggles, setChildToggles] = useState<Record<string, boolean>>({});
  const now = useNow(60_000);
  const branchOf = useSessionBranches(sessions, computers, readBranch);
  const inline = navigation === 'inline';
  const computerOf = (session: Session) =>
    computers.find(item => item.id === session.hostId);
  const matches = (session: Session) =>
    `${session.title} ${directoryLabel(session.directory)} ${computerOf(session)?.name ?? ''}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  const runOf = (session: Session) =>
    session.workflowRunId
      ? workflowRuns.find(
          run =>
            run.id === session.workflowRunId && run.hostId === session.hostId,
        )
      : undefined;
  const parentIdOf = (session: Session) =>
    session.parentId ??
    (session.workflowStepId ? (runOf(session)?.sessionId ?? null) : null);
  const statusText = (session: Session) => {
    const run = runOf(session);
    return showsRunStatus(session, run)
      ? `Workflow ${runStatusLabel(run.status)}`
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
  const automationKey = (session: Session) =>
    session.scheduledJobId ? `${session.hostId}/${session.scheduledJobId}` : '';
  const roots = sessions.filter(session => {
    if (session.scheduledJobId) return false;
    const parentId = parentIdOf(session);
    return (
      !parentId ||
      parentId === session.id ||
      !sessions.some(
        parent => parent.id === parentId && parent.hostId === session.hostId,
      )
    );
  });
  const allRoots = roots;
  const automationSessions = sessions.filter(
    session => session.scheduledJobId && (!search.trim() || matches(session)),
  );
  const filtered = roots.filter(
    root =>
      !hidesArchived(root) && (matches(root) || childrenOf(root).some(matches)),
  );
  const groups = computers
    .map(computer => ({
      computer,
      roots: filtered.filter(root => root.hostId === computer.id),
      automations: [
        ...new Set(
          automationSessions
            .filter(session => session.hostId === computer.id)
            .map(automationKey),
        ),
      ].map(key => {
        const runs = automationSessions.filter(
          session => automationKey(session) === key,
        );
        const job = scheduledJobs.find(
          item => `${item.hostId}/${item.id}` === key,
        );
        return { key, name: job?.name ?? '', runs };
      }),
    }))
    .filter(
      group =>
        group.roots.length > 0 ||
        group.automations.length > 0 ||
        (!!housekeeping &&
          organized(group.computer.id) &&
          (housekeeping.groups(group.computer.id).length > 0 ||
            roots.some(
              root => root.hostId === group.computer.id && root.archivedAt,
            ))),
    );
  const grouped = computers.length > 1;
  const isSelected = (session: Session) =>
    !inbox && !workflows && !pullRequests && selectedId === entityKey(session);
  type RowOptions = {
    child?: boolean;
    childCount?: number;
    expanded?: boolean;
    onToggle?: () => void;
    decoration?: RowDecoration;
  };
  const row = (
    session: Session,
    {
      child = false,
      childCount = 0,
      expanded = false,
      onToggle,
      decoration,
    }: RowOptions = {},
  ) => {
    const indent = (decoration?.depth ?? 0) * GROUP_INDENT_REM;
    const computer = computerOf(session);
    const selected = isSelected(session);
    const offline = computer?.status !== 'connected';
    const directory = directoryLabel(session.directory);
    const role = sessionRoleLabel(session);
    const remote = session.hostId !== 'local';
    const unread = !selected && !!unreadKeys?.has(entityKey(session));
    const branch = branchOf(session);
    const branchLabel =
      branch?.kind === 'branch'
        ? branch.name
        : branch?.kind === 'detached'
          ? branch.sha
          : null;
    const machine = computer?.name ?? session.hostId;
    const status = (
      <span
        className={cn(
          'shrink-0 text-2xs leading-none tabular-nums',
          decoration?.menu &&
            'group-focus-within/row:invisible group-hover/row:invisible group-has-[[data-state=open]]/row:invisible',
        )}
      >
        <SessionStatus
          session={session}
          run={runOf(session)}
          offline={offline}
          now={now}
        />
      </span>
    );
    return (
      <li
        key={entityKey(session)}
        {...decoration?.item}
        className={cn(
          'group/row relative',
          decoration?.dimmed && 'opacity-60',
          dropIndicatorClass(decoration?.indicator),
        )}
      >
        <button
          type="button"
          data-host-id={session.hostId}
          data-session-id={session.id}
          aria-current={selected ? 'page' : undefined}
          aria-label={`${session.title} · ${directory} · ${offline ? 'Offline' : statusText(session)}${unread ? ' · Unread' : ''}`}
          title={`${machine} · ${session.provider} · ${role || 'Session'} · ${statusText(session)}`}
          onClick={() => onSelect(entityKey(session))}
          style={
            indent
              ? {
                  paddingLeft: child
                    ? `${1.75 + indent}rem`
                    : `calc(var(--sidebar-row-inset) + ${indent}rem)`,
                }
              : undefined
          }
          className={cn(
            'flex w-full flex-col rounded-md text-left transition-colors duration-100 outline-none',
            'hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            child
              ? 'h-6 justify-center pr-2 pl-7'
              : 'gap-px py-1 pl-(--sidebar-row-inset)',
            !child && 'pr-2',
            selected &&
              'bg-sidebar-row-selected shadow-(--sidebar-row-selected-shadow) hover:bg-sidebar-row-selected',
          )}
        >
          <span className="relative flex h-4 min-w-0 items-center gap-1.5">
            {child ? (
              <CornerDownRight
                className="size-3 shrink-0 text-sidebar-icon"
                aria-hidden="true"
              />
            ) : (
              <ProjectChip label={directory} />
            )}
            {unread && (
              <span
                aria-hidden="true"
                className="absolute top-1/2 -left-2 size-1.5 -translate-y-1/2 rounded-full bg-foreground"
              />
            )}
            {session.pinned && !child && organized(session.hostId) && (
              <Pin
                className="size-2.5 shrink-0 text-sidebar-icon"
                aria-label="Pinned"
              />
            )}
            {decoration?.title ?? (
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs leading-4 text-sidebar-foreground',
                  unread ? 'font-semibold' : 'font-medium',
                )}
              >
                {session.title}
              </span>
            )}
            {status}
          </span>
          {!child && (
            <span className="flex h-3.5 min-w-0 items-center gap-1 pl-3.5 text-2xs leading-none text-sidebar-muted-foreground">
              <span className="min-w-6 shrink-[3] truncate">{directory}</span>
              {branchLabel && (
                <>
                  <MetaSeparator />
                  <GitBranch
                    className="size-2.5 shrink-0 text-sidebar-icon"
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      'min-w-8 truncate',
                      branch?.kind === 'detached' && 'font-mono',
                    )}
                  >
                    {branchLabel}
                  </span>
                </>
              )}
              {session.pullRequest && (
                <span
                  className="flex shrink-0 items-center gap-0.5 tabular-nums"
                  title={`${session.pullRequest.repository} #${session.pullRequest.number}`}
                >
                  <GitPullRequest
                    className="size-2.5 shrink-0 text-sidebar-icon"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Pull request</span>#
                  {session.pullRequest.number}
                </span>
              )}
              {!grouped && (
                <>
                  <MetaSeparator />
                  {remote ? (
                    <Cloud
                      className="size-2.5 shrink-0 text-sidebar-icon"
                      aria-hidden="true"
                    />
                  ) : (
                    <Monitor
                      className="size-2.5 shrink-0 text-sidebar-icon"
                      aria-hidden="true"
                    />
                  )}
                  <span className="max-w-20 shrink-0 truncate">{machine}</span>
                </>
              )}
              <span className="min-w-0 flex-1" />
              <ProviderGlyph
                provider={session.provider}
                className="size-3 text-sidebar-icon"
              />
            </span>
          )}
        </button>
        {decoration?.menu && (
          <span className="absolute top-0.5 right-1 hidden rounded-sm bg-sidebar-row-hover group-focus-within/row:flex group-hover/row:flex has-[[data-state=open]]:flex">
            {decoration.menu}
          </span>
        )}
        {childCount > 0 && onToggle && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} ${childCount} subsessions of ${session.title}`}
            title={`${childCount} ${childCount === 1 ? 'subsession' : 'subsessions'}`}
            style={indent ? { left: `${0.25 + indent}rem` } : undefined}
            className="absolute top-[1.125rem] left-1 flex size-5 items-center justify-center rounded-sm text-sidebar-icon transition-colors duration-100 outline-none hover:bg-sidebar-row-selected hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onToggle}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-3 shrink-0 transition-transform duration-150',
                !expanded && '-rotate-90',
              )}
            />
          </button>
        )}
      </li>
    );
  };
  const rootWithChildren = (root: Session, decoration?: RowDecoration) => {
    const children = childrenOf(root).filter(
      child => matches(root) || matches(child),
    );
    const childDecoration = decoration && { depth: decoration.depth };
    if (children.length === 0) return [row(root, { decoration })];
    const key = entityKey(root);
    const expanded =
      childToggles[key] ??
      (!!search.trim() || children.some(child => isSelected(child)));
    return [
      row(root, {
        childCount: children.length,
        expanded,
        onToggle: () =>
          setChildToggles(previous => ({ ...previous, [key]: !expanded })),
        decoration,
      }),
      ...(expanded
        ? children.map(child =>
            row(child, { child: true, decoration: childDecoration }),
          )
        : []),
    ];
  };
  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
        <div className="drag-region flex h-(--shell-topbar-height) shrink-0 items-center gap-1.5 pr-2 pl-[calc(0.5rem+var(--titlebar-inset-left))]">
          {inline && onCollapse && (
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
          <BrandWordmark
            className={cn('select-none', !(inline && onCollapse) && 'ml-1')}
          />
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
            {housekeeping && organized(currentHostId) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 text-sidebar-icon hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    aria-label="New group"
                    onClick={() => {
                      setSearch('');
                      void housekeeping
                        .createGroup(currentHostId, null, 'New group')
                        .then(id => {
                          if (id) setRenaming(`g:${id}`);
                        });
                    }}
                  >
                    <FolderPlus className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">New group</TooltipContent>
              </Tooltip>
            )}
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
          {search.trim() && (
            <button
              type="button"
              className={navButtonClass}
              onClick={() => onSearchHistory(search)}
            >
              <Search className="size-4 text-sidebar-icon" aria-hidden="true" />
              Search all history
            </button>
          )}
          {inline && (
            <>
              <button
                type="button"
                className={cn(
                  navButtonClass,
                  inbox && 'bg-sidebar-row-selected text-sidebar-foreground',
                )}
                onClick={onInbox}
                aria-current={inbox ? 'page' : undefined}
              >
                <Inbox
                  className="size-4 text-sidebar-icon"
                  aria-hidden="true"
                />
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
              {automationsAvailable && onAutomations && (
                <button
                  type="button"
                  className={cn(
                    navButtonClass,
                    automations &&
                      'bg-sidebar-row-selected text-sidebar-foreground',
                  )}
                  onClick={onAutomations}
                  aria-current={automations ? 'page' : undefined}
                >
                  <CalendarClock
                    className="size-4 text-sidebar-icon"
                    aria-hidden="true"
                  />
                  Automations
                </button>
              )}
              <button
                type="button"
                className={cn(
                  navButtonClass,
                  workflows &&
                    'bg-sidebar-row-selected text-sidebar-foreground',
                )}
                onClick={onWorkflows}
                aria-current={workflows ? 'page' : undefined}
              >
                <Workflow
                  className="size-4 text-sidebar-icon"
                  aria-hidden="true"
                />
                Workflows
              </button>
              {onPullRequests && (
                <button
                  type="button"
                  className={cn(
                    navButtonClass,
                    pullRequests &&
                      'bg-sidebar-row-selected text-sidebar-foreground',
                  )}
                  onClick={onPullRequests}
                  aria-current={pullRequests ? 'page' : undefined}
                >
                  <GitPullRequest
                    className="size-4 text-sidebar-icon"
                    aria-hidden="true"
                  />
                  Pull requests
                </button>
              )}
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          {housekeeping?.error && (
            <p
              role="alert"
              className="mx-(--sidebar-inset) mb-1 flex items-start gap-1 rounded-md bg-sidebar-row-hover px-2 py-1.5 text-2xs text-error-foreground"
            >
              <span className="min-w-0 flex-1">{housekeeping.error}</span>
              <button
                type="button"
                aria-label="Dismiss"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-sidebar-icon outline-none hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
                onClick={housekeeping.clearError}
              >
                <X className="size-3" />
              </button>
            </p>
          )}
          <nav
            aria-label="Sessions"
            className="space-y-1 px-(--sidebar-inset) pb-3"
          >
            {groups.map(({ computer, roots, automations: jobGroups }) => {
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
                          {roots.length + jobGroups.length}
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
                      {!organized(computer.id) &&
                        roots.flatMap(root => rootWithChildren(root))}
                      {(() => {
                        const automationRows = jobGroups.map(group => {
                          const expanded =
                            jobToggles[group.key] ??
                            (!!search.trim() ||
                              group.runs.some(
                                session =>
                                  !inbox && selectedId === entityKey(session),
                              ));
                          return (
                            <li key={`automation/${group.key}`}>
                              <button
                                type="button"
                                aria-expanded={expanded}
                                data-automation-group={group.key}
                                className="flex h-7 w-full items-center gap-2 rounded-md px-(--sidebar-row-inset) text-left text-sidebar-muted-foreground transition-colors duration-100 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                                onClick={() =>
                                  setJobToggles(previous => ({
                                    ...previous,
                                    [group.key]: !expanded,
                                  }))
                                }
                              >
                                <CalendarClock
                                  className="size-3.5 shrink-0 text-sidebar-icon"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                                  {group.name
                                    ? `Automation · ${group.name}`
                                    : 'Automation'}
                                </span>
                                {group.runs.some(
                                  session =>
                                    session.status === 'running' ||
                                    session.status === 'stopping',
                                ) && (
                                  <span className="text-xs font-medium text-info-foreground">
                                    Working
                                  </span>
                                )}
                                <span className="text-xs tabular-nums">
                                  {group.runs.length}
                                </span>
                                <ChevronDown
                                  aria-hidden="true"
                                  className={cn(
                                    'size-3 shrink-0 text-sidebar-icon transition-transform duration-150',
                                    !expanded && '-rotate-90',
                                  )}
                                />
                              </button>
                              {expanded && (
                                <ul className="flex flex-col gap-0.5">
                                  {group.runs.map(session =>
                                    row(session, { child: true }),
                                  )}
                                </ul>
                              )}
                            </li>
                          );
                        });
                        return organized(computer.id) && housekeeping ? (
                          <GroupedSessions
                            hostId={computer.id}
                            roots={roots}
                            allRoots={allRoots.filter(
                              root => root.hostId === computer.id,
                            )}
                            housekeeping={housekeeping}
                            searching={!!search.trim()}
                            renaming={renaming}
                            onRenamingChange={setRenaming}
                            archivedOpen={archivedHosts.includes(computer.id)}
                            onArchivedOpenChange={open =>
                              setArchivedHosts(previous =>
                                open
                                  ? [...previous, computer.id]
                                  : previous.filter(id => id !== computer.id),
                              )
                            }
                            isCollapsed={collapsed.isCollapsed}
                            onToggleCollapsed={collapsed.toggle}
                            renderRoot={rootWithChildren}
                            automations={automationRows}
                          />
                        ) : (
                          automationRows
                        );
                      })()}
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
        {inline && (
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
        )}
      </div>
    </>
  );
}
