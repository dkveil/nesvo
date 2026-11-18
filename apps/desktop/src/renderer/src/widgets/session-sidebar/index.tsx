import { useState, type ReactNode, type RefObject } from 'react';
import {
  CalendarClock,
  ChevronDown,
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
  sessionStatusLabel,
  statusTones,
  type Session,
} from '@/entities/session';
import { StatusIcon, toneText } from '@/entities/status';
import {
  runStatusLabel,
  runStatusTones,
  showsRunStatus,
  type WorkflowRun,
} from '@/entities/workflow';
import type { ScheduledJob } from '@/entities/scheduled-job';
import { CountBadge } from '@/shared/ui/badge';
import { BrandWordmark } from '@/shared/ui/brand-wordmark';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { NavItem } from '@/shared/ui/nav-list';
import { ProjectChip } from '@/shared/ui/project-chip';
import { SearchField } from '@/shared/ui/search-field';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { toDropIndicator } from './drop-indicator';
import { GroupedSessions } from './grouped-sessions';
import type { RowDecoration, SidebarHousekeeping } from './housekeeping';
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
  loading?: boolean;
};

const TREE_INDENT_PX = 12;

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
  if (offline) return <span>Offline</span>;
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
      <time dateTime={session.updatedAt}>
        {formatRelativeTime(session.updatedAt, now)}
      </time>
    );
  const label = sessionStatusLabel(session);
  const tone =
    label === 'Needs approval' ? 'warning' : statusTones[session.status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-medium',
        tone && toneText[tone],
      )}
    >
      {session.status === 'completed' && <StatusIcon status="success" />}
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
  loading = false,
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
    const depth = decoration?.depth ?? 0;
    const computer = computerOf(session);
    const selected = isSelected(session);
    const offline = computer?.status !== 'connected';
    const directory = directoryLabel(session.directory);
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
    const renamingField = decoration?.title;
    const status = (
      <SessionStatus
        session={session}
        run={runOf(session)}
        offline={offline}
        now={now}
      />
    );
    const title = renamingField ?? (
      <span className="flex min-w-0 items-center gap-1.5">
        {session.pinned && !child && organized(session.hostId) && (
          <Pin
            className="size-2.5 shrink-0 text-sidebar-icon"
            aria-label="Pinned"
          />
        )}
        <span className={cn('min-w-0 truncate', unread && 'font-semibold')}>
          {session.title}
        </span>
      </span>
    );
    const details = (
      <span className="flex min-w-0 items-center gap-1">
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
          <span className="flex shrink-0 items-center gap-0.5 tabular-nums">
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
    );
    const leading = child ? (
      <CornerDownRight className="size-3" aria-hidden="true" />
    ) : (
      <span className="relative flex">
        {unread && (
          <StatusDot
            tone="strong"
            className="absolute top-1/2 -left-2 -translate-y-1/2"
          />
        )}
        <ProjectChip label={directory} />
      </span>
    );
    return (
      <li
        key={entityKey(session)}
        className={cn('relative', decoration?.dimmed && 'opacity-60')}
      >
        <ListRow
          tone="sidebar"
          size="sm"
          density={child ? 'tree' : 'two-line'}
          level={child ? depth + 1 : depth}
          leading={leading}
          title={title}
          meta={child ? undefined : status}
          trailing={child ? status : undefined}
          description={child ? undefined : details}
          selected={selected}
          actions={decoration?.menu}
          actionsPlacement="overlay"
          dropIndicator={toDropIndicator(decoration?.indicator)}
          className={cn(renamingField && 'focus-ring-within')}
          onClick={
            renamingField ? undefined : () => onSelect(entityKey(session))
          }
          mainProps={{
            ...{
              'data-host-id': session.hostId,
              'data-session-id': session.id,
            },
            'aria-current': selected ? 'page' : undefined,
            'aria-label': `${session.title} · ${directory} · ${offline ? 'Offline' : statusText(session)}${unread ? ' · Unread' : ''}`,
          }}
          {...decoration?.item}
        />
        {childCount > 0 && onToggle && (
          <IconButton
            label={`${expanded ? 'Hide' : 'Show'} ${childCount} subsessions of ${session.title}`}
            size={20}
            tone="sidebar"
            aria-expanded={expanded}
            className="absolute top-4.5"
            style={{ left: 2 + depth * TREE_INDENT_PX }}
            onClick={onToggle}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'transition-transform duration-base ease-out',
                !expanded && '-rotate-90',
              )}
            />
          </IconButton>
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
  const hostIcon = (hostId: string) =>
    hostId === 'local' ? <Monitor /> : <Cloud />;
  const disclosureChevron = (open: boolean) => (
    <ChevronDown
      aria-hidden="true"
      className={cn(
        'size-3 shrink-0 text-sidebar-icon transition-transform duration-base ease-out',
        !open && '-rotate-90',
      )}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="drag-region flex h-(--shell-topbar-height) shrink-0 items-center gap-1.5 pr-2 pl-[calc(0.5rem+var(--titlebar-inset-left))]">
        {inline && onCollapse && (
          <IconButton
            ref={collapseToggleRef}
            label="Toggle sidebar"
            shortcut="Ctrl B"
            tone="sidebar"
            aria-pressed="true"
            onClick={onCollapse}
          >
            <PanelLeft />
          </IconButton>
        )}
        <BrandWordmark
          className={cn('select-none', !(inline && onCollapse) && 'ml-1')}
        />
      </div>
      <div className="space-y-0.5 px-(--sidebar-inset) pb-2">
        <div className="flex items-center gap-0.5">
          <SearchField
            variant="sidebar"
            aria-label="Search sessions"
            placeholder="Search"
            containerClassName="min-w-0 flex-1"
            value={search}
            onChange={event => setSearch(event.target.value)}
            onClear={() => setSearch('')}
            onKeyDown={event => {
              if (event.key === 'Escape' && search) {
                event.preventDefault();
                setSearch('');
              }
            }}
          />
          {housekeeping && organized(currentHostId) && (
            <IconButton
              label="New group"
              tone="sidebar"
              tooltipSide="bottom"
              onClick={() => {
                setSearch('');
                void housekeeping
                  .createGroup(currentHostId, null, 'New group')
                  .then(id => {
                    if (id) setRenaming(`g:${id}`);
                  });
              }}
            >
              <FolderPlus />
            </IconButton>
          )}
          <IconButton
            label="New session"
            tone="sidebar"
            tooltipSide="bottom"
            onClick={onCreate}
          >
            <SquarePen />
          </IconButton>
        </div>
        {search.trim() && (
          <NavItem
            tone="sidebar"
            size="md"
            icon={<Search />}
            onClick={() => onSearchHistory(search)}
          >
            Search all history
          </NavItem>
        )}
        {inline && (
          <>
            <NavItem
              tone="sidebar"
              size="md"
              icon={<Inbox />}
              selected={inbox}
              onClick={onInbox}
              trailing={
                pendingActions > 0 && (
                  <CountBadge
                    count={pendingActions}
                    tone="muted"
                    aria-label={`${pendingActions} pending items`}
                  />
                )
              }
            >
              Inbox
            </NavItem>
            {automationsAvailable && onAutomations && (
              <NavItem
                tone="sidebar"
                size="md"
                icon={<CalendarClock />}
                selected={automations}
                onClick={onAutomations}
              >
                Automations
              </NavItem>
            )}
            <NavItem
              tone="sidebar"
              size="md"
              icon={<Workflow />}
              selected={workflows}
              onClick={onWorkflows}
            >
              Workflows
            </NavItem>
            {onPullRequests && (
              <NavItem
                tone="sidebar"
                size="md"
                icon={<GitPullRequest />}
                selected={pullRequests}
                onClick={onPullRequests}
              >
                Pull requests
              </NavItem>
            )}
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {housekeeping?.error && (
          <div className="relative mx-(--sidebar-inset) mb-1">
            <StatusMessage tone="error" variant="notice" className="pr-8">
              {housekeeping.error}
            </StatusMessage>
            <IconButton
              label="Dismiss"
              size={20}
              tone="sidebar"
              className="absolute top-1.5 right-1.5"
              onClick={housekeeping.clearError}
            >
              <X />
            </IconButton>
          </div>
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
                  <ListRow
                    tone="sidebar"
                    size="sm"
                    heading
                    leading={hostIcon(computer.id)}
                    title={computer.name}
                    trailing={
                      <>
                        {computer.status !== 'connected' && 'Offline'}
                        {closed && (
                          <span>{roots.length + jobGroups.length}</span>
                        )}
                        {disclosureChevron(!closed)}
                      </>
                    }
                    mainProps={{ 'aria-expanded': !closed }}
                    onClick={() =>
                      setClosedHosts(previous =>
                        closed
                          ? previous.filter(id => id !== computer.id)
                          : [...previous, computer.id],
                      )
                    }
                  />
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
                        const working = group.runs.some(
                          session =>
                            session.status === 'running' ||
                            session.status === 'stopping',
                        );
                        return (
                          <li key={`automation/${group.key}`}>
                            <ListRow
                              tone="sidebar"
                              size="sm"
                              heading
                              leading={<CalendarClock />}
                              title={
                                group.name
                                  ? `Automation · ${group.name}`
                                  : 'Automation'
                              }
                              trailing={
                                <>
                                  {working && (
                                    <span className="font-medium text-info-foreground">
                                      Working
                                    </span>
                                  )}
                                  <span>{group.runs.length}</span>
                                  {disclosureChevron(expanded)}
                                </>
                              }
                              mainProps={{
                                ...{ 'data-automation-group': group.key },
                                'aria-expanded': expanded,
                              }}
                              onClick={() =>
                                setJobToggles(previous => ({
                                  ...previous,
                                  [group.key]: !expanded,
                                }))
                              }
                            />
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
          {groups.length === 0 && loading && (
            <SkeletonList
              label="Loading sessions"
              density="two-line"
              leading={false}
              rows={6}
              className="pt-2"
            />
          )}
          {groups.length === 0 && !loading && (
            <EmptyState
              size="sm"
              title={search ? 'No matching sessions.' : 'No sessions yet.'}
              className="text-sidebar-muted-foreground"
            />
          )}
        </nav>
      </div>
      {inline && (
        <div className="flex h-10 shrink-0 items-center gap-0.5 px-(--sidebar-inset)">
          <IconButton label="Settings" tone="sidebar" onClick={onSettings}>
            <Settings />
          </IconButton>
          {footerStart}
          <div className="min-w-0 flex-1" />
          <Hint label={`Computers · ${hostName}`}>
            <Button
              variant="ghost"
              size="sm"
              className="max-w-28 min-w-0 shrink text-sidebar-muted-foreground"
              aria-label="Computers"
              onClick={onComputers}
            >
              <Monitor />
              <span className="truncate">{hostName}</span>
            </Button>
          </Hint>
        </div>
      )}
    </div>
  );
}
