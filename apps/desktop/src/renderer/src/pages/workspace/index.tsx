import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ConversationIdentity,
  CreateSessionInput,
  SessionGroup,
  DecideDelegationInput,
  DecideWorkerPlanInput,
  DecideReviewInput,
  DesktopReview as Review,
  DesktopSession as Session,
  ForkSessionInput,
  McpSelection,
  MessageAttachment,
  RespondApprovalInput,
  SessionMode,
  StartWorkflowTaskInput,
} from '@nesvo/contracts';
import { isGroupableSession } from '@nesvo/contracts';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookOpen,
  FolderInput,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Trash2,
  FileCode2,
  FolderCheck,
  FolderOpen,
  Gauge,
  FileDown,
  GitFork,
  GitPullRequest,
  History,
  Menu,
  PanelRight,
  Plus,
  SquareDashed,
  SquareTerminal,
  WifiOff,
} from 'lucide-react';
import {
  directoryLabel,
  errorDetail,
  providerModes,
  providerStatusLabel,
  sessionFilterKeys,
  sessionMarkdown,
  sessionMarkdownFileName,
  sessionRoleLabel,
  sessionStatusLabel,
} from '@/entities/session';
import { showsRunStatus } from '@/entities/workflow';
import type { EditorTarget } from '@/widgets/workflow-definitions';
import type { AssistantContext } from '@/widgets/workflow-assistant';
import type { AssistantChange } from '@nesvo/contracts';
import {
  NewWorkflowSheet,
  type NewWorkflowDraft,
} from '@/features/new-workflow/new-workflow-sheet';
import type { SkillSummary } from '@/widgets/workflow-graph-editor/inspector';
import { NewThread, type ThreadSetup } from '@/features/new-thread';
import {
  applyNewSessionDefaults,
  defaultProfileKey,
  readNewSessionDefaults,
} from '@/features/new-thread/new-session-defaults';
import { resolveGate } from '@/features/new-thread/workflow-choice';
import {
  AutomationEditor,
  automationValues,
  duplicateValues,
  newAutomationValues,
  type AutomationValues,
} from '@/features/edit-automation';
import { ManageComputers } from '@/features/manage-computers';
import { HistorySearchDialog } from '@/features/search-history';
import { ImportConversation } from '@/features/import-conversation';
import {
  CommandPalette,
  type PaletteCommand,
  type PaletteMode,
} from '@/features/command-palette';
import { SessionDeletion } from '@/features/delete-session';
import { RenameSessionDialog } from '@/features/rename-session';
import { MoveToGroupDialog } from '@/widgets/session-sidebar/move-to-group-dialog';
import { shortcutKeys } from '@/shared/lib/keyboard-shortcuts';
import { MobileAccess } from '@/features/mobile-access';
import { entityKey, hostKey } from '@/shared/lib/host-key';
import { hasEarlierMessages, terminalResume } from '@nesvo/contracts';
import {
  TerminalCommandDialog,
  TerminalHandoffNotice,
} from '@/features/session-terminal';
import type { SelectedSkill } from '@/features/select-skill';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { BranchChip } from '@/features/git-branch/branch-chip';
import { useGitBranch } from '@/features/git-branch/use-git-branch';
import { FinishWorktreeDialog } from '@/features/session-worktree/finish-worktree';
import { ForkWorktreeDialog } from '@/features/session-worktree/fork-worktree';
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { ProjectChip } from '@/shared/ui/project-chip';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/ui/sheet';
import { StatusMessage } from '@/shared/ui/status-message';
import { Conversation, type ModelSelection } from '@/widgets/conversation';
import { Delegations } from '@/widgets/delegations';
import { WorkflowStatus } from '@/widgets/workflow-status';
import { ReviewInbox } from '@/widgets/review-inbox';
import { SessionDetails } from '@/widgets/session-details';
import { SessionActivity } from '@/widgets/session-activity';
import { SessionReviews } from '@/widgets/session-reviews';
import { NavigationRail } from '@/widgets/navigation-rail';
import { CostsView } from '@/widgets/costs';
import { SessionSidebar } from '@/widgets/session-sidebar';
import {
  RowActionsMenu,
  type RowAction,
} from '@/widgets/session-sidebar/row-actions-menu';
import { useHousekeeping } from './use-housekeeping';
import { BrandWordmark } from '@/shared/ui/brand-wordmark';
import {
  ContextSection,
  WorkflowSection,
  SessionCard,
  UsageSection,
  WorkersSection,
} from '@/widgets/session-card';
import { ProviderUsage } from '@/widgets/provider-rail';
import { ProviderProfileSettings } from '@/widgets/provider-rail/provider-profile-settings';
import { useProfileStatus } from '@/features/provider-profiles/use-profile-status';
import { Chip } from '@/shared/ui/chip';
import { Hint } from '@/shared/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import {
  AboutSettings,
  AppearanceSettings,
  DataSettings,
  DefaultsSettings,
  GeneralSettings,
  KeyboardShortcutsSettings,
  NotificationsSettings,
  Settings,
  type SettingsPage,
} from '@/widgets/settings';
import { AutomationDetail, AutomationList } from '@/widgets/automations';
import type { ScheduledJob, ScheduledJobRun } from '@/entities/scheduled-job';
import { cn } from '@/shared/lib/cn';
import { desktopApi, useSessions } from './use-sessions';
import { supportsScheduledJobs, useScheduledJobs } from './use-scheduled-jobs';
import { readDrafts, writeDrafts } from './draft-store';
import { SessionWorkflowChip } from '@/features/session-workflow';
import { imageSupport } from '@/features/attach-images/image-support';
import { useComposerAttachments } from '@/features/attach-images/use-composer-attachments';
import {
  placeInText,
  withoutPlacement,
} from '@/features/attach-images/placement';
import { McpChip } from '@/features/session-mcp/mcp-chip';
import { CompactInstructionsDialog } from '@/features/conversation-context/compact-instructions-dialog';
import { ContextMeter } from '@/features/conversation-context/context-meter';
import { conversationActions } from '@/features/conversation-context/conversation-actions';
import { SessionPullRequest } from '@/features/session-pull-request';
import {
  pullRequestsUnavailableReason,
  referenceKey,
  sameReference,
  type PullRequestTarget,
} from '@/entities/pull-request';
import { PullRequestsView } from '@/widgets/pull-requests';
import { readSeen, writeSeen } from './seen-store';
import { useAttention } from './use-attention';
import { useBackgroundAttention } from './use-background-attention';
import { useProviderProfiles } from './use-provider-profiles';
import { useProviderUsage } from './use-provider-usage';
import { readWorkspaceLocation, saveWorkspaceLocation } from './location';
import { readSidebarOpen, saveSidebarOpen } from './sidebar-preference';
import {
  readSessionFilter,
  saveSessionFilter,
} from './session-filter-preference';
import {
  focusSidebarSession,
  isSidebarSessionFocused,
  sidebarSection,
  sidebarSessionKeys,
} from './sidebar-order';
import { useWorkspaceShortcuts } from './use-workspace-shortcuts';
import { paletteSessions, workspaceCommands } from './workspace-commands';
import { PanelPlaceholder } from './panel-placeholder';
import { SidebarResizer } from './sidebar-resizer';
import {
  clampSidebarWidth,
  readSidebarWidth,
  saveSidebarWidth,
} from './sidebar-width';

const ReviewDiff = lazy(() => import('@/widgets/review-diff'));

const WorkspaceFiles = lazy(() => import('@/widgets/workspace-files'));

const SessionSkills = lazy(() => import('@/widgets/session-skills'));

const PullRequestPanel = lazy(() => import('@/widgets/pull-request'));

const DRAFT_LIMIT_CHARACTERS = 32_000;

const WorkflowDefinitions = lazy(
  () => import('@/widgets/workflow-definitions'),
);

const WorkflowAssistantDock = lazy(
  () => import('@/widgets/workflow-assistant'),
);

const WorkflowGraphEditor = lazy(
  () => import('@/widgets/workflow-graph-editor'),
);

const ComponentCatalog = import.meta.env.DEV
  ? lazy(() => import('@/widgets/component-catalog'))
  : null;

const samePlace = (left: string, right: string) =>
  left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
  right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const assistantAddedNames = (
  changes: AssistantChange[],
  kind: AssistantChange['kind'],
  directory: string,
) =>
  changes
    .filter(
      change =>
        change.status === 'applied' &&
        change.kind === kind &&
        change.op === 'create' &&
        change.target.type === 'definition' &&
        samePlace(change.directory, directory),
    )
    .map(change =>
      change.target.type === 'definition' ? change.target.name : '',
    );

export function Workspace() {
  const store = useSessions();
  const [location] = useState(readWorkspaceLocation);
  const [selectedId, setSelectedId] = useState(location.selectedId);
  const [inbox, setInbox] = useState(location.inbox);
  const [costsView, setCostsView] = useState(false);
  const [automation, setAutomation] = useState(location.automation);
  const [editor, setEditor] = useState<{
    initial: AutomationValues;
    jobKey: string;
  } | null>(null);
  const [automationPending, setAutomationPending] = useState<
    Record<string, boolean>
  >({});
  const [automationErrors, setAutomationErrors] = useState<
    Record<string, string>
  >({});
  const runRequests = useRef<Record<string, { id: string; at: string }>>({});
  const [sessionTarget, setSessionTarget] = useState('');
  const [palette, setPalette] = useState<{
    mode: PaletteMode;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const [sessionFilter, setSessionFilter] = useState(readSessionFilter);
  const lastSelection = useRef({ current: '', previous: '' });
  const [terminalPending, setTerminalPending] = useState('');
  const [terminalNames, setTerminalNames] = useState<Record<string, string>>(
    {},
  );
  const [terminalCommand, setTerminalCommand] = useState<{
    session: Session;
    command: string;
  } | null>(null);
  const [terminalCommandError, setTerminalCommandError] = useState('');
  const [transcriptImport, setTranscriptImport] = useState<{
    hostId: string;
    conversation: ConversationIdentity;
  } | null>(null);
  const [historySearch, setHistorySearch] = useState<{
    query: string;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const [messageTarget, setMessageTarget] = useState<{ id: string } | null>(
    null,
  );
  const [panel, setPanel] = useState<
    'diff' | 'files' | 'skills' | 'pull-request' | null
  >(location.diff ? 'diff' : null);
  const [pullRequestsView, setPullRequestsView] = useState(false);
  const [pullRequestHandoff, setPullRequestHandoff] = useState<Session | null>(
    null,
  );
  const [pullRequestTarget, setPullRequestTarget] =
    useState<PullRequestTarget | null>(null);
  const [workflowsView, setWorkflowsView] = useState(false);
  const [workflowsSource, setWorkflowsSource] = useState({
    hostId: 'local',
    directory: '',
  });
  const [workflowsEditor, setWorkflowsEditor] = useState<EditorTarget | null>(
    null,
  );
  const [newWorkflow, setNewWorkflow] = useState<{
    hostId: string;
    directory: string;
  } | null>(null);
  const [definitionsRefresh, setDefinitionsRefresh] = useState(0);
  const assistantChangesFor = (hostId: string) =>
    store.assistantChanges[hostId] ?? [];
  const assistantRefusalsFor = (hostId: string) =>
    store.assistantRefusals[hostId] ?? [];
  const editorAssistantAdded = useMemo(
    () =>
      workflowsEditor
        ? assistantAddedNames(
            store.assistantChanges[workflowsEditor.hostId] ?? [],
            'step',
            workflowsEditor.directory,
          )
        : [],
    [store.assistantChanges, workflowsEditor],
  );
  const listAssistantAdded = useMemo(
    () =>
      assistantAddedNames(
        store.assistantChanges[workflowsSource.hostId] ?? [],
        'workflow',
        workflowsSource.directory,
      ),
    [store.assistantChanges, workflowsSource],
  );
  const loadAssistantChanges = async (
    hostId: string,
    conversationId: string,
  ) => {
    try {
      const history = await window.nesvo.workflows.assistantChanges(
        hostId,
        conversationId,
      );
      for (const change of history.changes)
        store.recordAssistantChange(hostId, change);
    } catch {
      return;
    }
  };
  const stopAssistantSession = async (hostId: string, sessionId: string) => {
    const session = store.sessions.find(
      item => item.id === sessionId && item.hostId === hostId,
    );
    if (!session?.runId) return;
    await desktopApi(hostId).stopRun({ sessionId, runId: session.runId });
  };
  const undoAssistantChange = async (
    hostId: string,
    change: AssistantChange,
  ) => {
    const result = await window.nesvo.workflows.assistantUndo(hostId, {
      conversationId: change.conversationId,
      changeId: change.changeId,
    });
    if (result.status === 'undone') {
      store.recordAssistantChange(hostId, result.change);
      if (result.change.kind === 'automation') void automations.reload(hostId);
      else setDefinitionsRefresh(version => version + 1);
    }
    return result;
  };
  const assistantAddedAutomations = (hostId: string) =>
    assistantChangesFor(hostId)
      .filter(
        change =>
          change.status === 'applied' &&
          change.kind === 'automation' &&
          change.op === 'create' &&
          change.target.type === 'automation',
      )
      .map(change =>
        change.target.type === 'automation' ? change.target.automationId : '',
      );
  const canOpenAssistantChange =
    (inEditor: boolean) => (change: AssistantChange) =>
      change.op !== 'delete' &&
      (change.kind === 'workflow' ||
        change.kind === 'automation' ||
        (inEditor && change.kind === 'step'));
  const openAssistantChange = (hostId: string, change: AssistantChange) => {
    if (change.target.type === 'automation') {
      const job = automations.jobs.find(
        item =>
          item.hostId === hostId &&
          change.target.type === 'automation' &&
          item.id === change.target.automationId,
      );
      if (job) openAutomations(entityKey(job));
      return;
    }
    if (change.kind !== 'workflow' || change.target.type !== 'definition')
      return;
    const name = change.target.name;
    guardEditor(() => {
      void window.nesvo.workflows
        .listDefinitions(hostId, { directory: change.directory })
        .then(catalog => {
          navigationVersion.current += 1;
          setPanel(null);
          setDiffTarget(null);
          setCreating(false);
          setInbox(false);
          setCostsView(false);
          setAutomation('');
          setWorkflowsView(true);
          setPullRequestsView(false);
          setNavigationOpen(false);
          setWorkflowsSource({ hostId, directory: change.directory });
          setWorkflowsEditor({
            hostId,
            directory: change.directory,
            workflowName: catalog.workflows.some(item => item.name === name)
              ? name
              : null,
            catalog,
          });
        })
        .catch(() => undefined);
    });
  };
  const assignWorkflow = async (
    session: Session,
    workflow: Session['workflow'],
  ) => {
    const key = entityKey(session);
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      store.merge([
        await desktopApi(session.hostId).assignSessionWorkflow(
          { sessionId: session.id, workflow },
          session.hostId,
        ),
      ]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `Could not assign the workflow. ${errorDetail(failure)}`,
      }));
    }
  };
  const changeMcp = async (session: Session, selection: McpSelection) => {
    const key = entityKey(session);
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      store.merge([
        await desktopApi(session.hostId).setSessionMcp(
          { sessionId: session.id, ...selection },
          session.hostId,
        ),
      ]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `Could not change MCP servers or hooks. ${errorDetail(failure)}`,
      }));
    }
  };
  const openWorkflowEditor = (
    hostId: string,
    directory: string,
    name: string,
  ) => {
    guardEditor(() => {
      void window.nesvo.workflows
        .listDefinitions(hostId, { directory })
        .then(catalog => {
          navigationVersion.current += 1;
          setPanel(null);
          setDiffTarget(null);
          setCreating(false);
          setInbox(false);
          setCostsView(false);
          setAutomation('');
          setWorkflowsView(true);
          setPullRequestsView(false);
          setNavigationOpen(false);
          setWorkflowsSource({ hostId, directory });
          setWorkflowsEditor({
            hostId,
            directory,
            workflowName: catalog.workflows.some(item => item.name === name)
              ? name
              : null,
            catalog,
          });
        })
        .catch(() => undefined);
    });
  };
  const runAssignedWorkflow = async (session: Session) => {
    const key = entityKey(session);
    const assigned = session.workflow;
    if (!assigned || !store.hostReady(session.hostId)) return;
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      const catalog = await window.nesvo.workflows.listDefinitions(
        session.hostId,
        { directory: session.directory },
      );
      const spec = catalog.specs.find(
        item =>
          item.workflow === assigned.name &&
          item.source.scope === assigned.root,
      );
      if (!spec)
        throw new Error('No task spec is available for this workflow.');
      const gate = resolveGate(
        null,
        session.provider,
        store.providerStates(session.hostId),
      );
      const run = await window.nesvo.workflows.startTask(session.hostId, {
        specPath: spec.source.path,
        workflowName: assigned.name,
        provider: session.provider,
        model: session.model,
        ...(session.effort ? { effort: session.effort } : {}),
        mode: session.provider === 'Claude Code' ? 'read-only' : session.mode,
        directory: session.directory,
        isolation: 'none',
        gateProvider: gate.provider,
        gateModel: gate.model,
      });
      store.mergeWorkflowRuns([run]);
      if (!run.sessionId) return;
      const history = await store.recover(session.hostId);
      const authored = history.find(item => item.id === run.sessionId);
      if (authored) select(entityKey(authored));
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `Could not run the workflow. ${errorDetail(failure)}`,
      }));
    }
  };
  const assistantDock = (
    hostId: string,
    directory: string,
    context: AssistantContext,
    onApplied: () => void,
  ) => (
    <div
      data-slot="editor-dock"
      className="pointer-events-none absolute right-3 bottom-3 z-10 [&>*]:pointer-events-auto"
    >
      <Suspense fallback={null}>
        <WorkflowAssistantDock
          hostId={hostId}
          directory={directory}
          context={context}
          statuses={store.providerStates(hostId)}
          computers={store.computers}
          sessions={store.sessions}
          proposals={store.assistantProposals}
          changes={assistantChangesFor(hostId)}
          refusals={assistantRefusalsFor(hostId)}
          onRefreshProvider={provider =>
            void store.refreshProvider(provider, hostId)
          }
          onApplied={onApplied}
          onOpenSession={sessionId => select(hostKey(sessionId, hostId))}
          onLoadSession={openSession}
          onStop={sessionId => stopAssistantSession(hostId, sessionId)}
          onUndo={change => undoAssistantChange(hostId, change)}
          onOpenChange={change => openAssistantChange(hostId, change)}
          canOpenChange={canOpenAssistantChange(false)}
          onLoadChanges={conversationId =>
            loadAssistantChanges(hostId, conversationId)
          }
        />
      </Suspense>
    </div>
  );
  const refreshAfterAssistant = (hostId: string) => {
    setDefinitionsRefresh(version => version + 1);
    void automations.reload(hostId);
  };
  const createWorkflow = async (draft: NewWorkflowDraft) => {
    const catalog = await window.nesvo.workflows.listDefinitions(draft.hostId, {
      directory: draft.directory,
    });
    setWorkflowsSource({ hostId: draft.hostId, directory: draft.directory });
    setWorkflowsEditor({
      hostId: draft.hostId,
      directory: draft.directory,
      workflowName: null,
      catalog,
      draft: {
        name: draft.name,
        description: draft.description,
        body: draft.body,
        scope: draft.scope,
      },
    });
    setNewWorkflow(null);
  };
  const [editorDirty, setEditorDirty] = useState(false);
  const [leaveEditor, setLeaveEditor] = useState<(() => void) | null>(null);
  const browsing =
    inbox || costsView || workflowsView || pullRequestsView || !!automation;
  const editorHostId = workflowsEditor?.hostId ?? '';
  const discoverEditorSkills = useCallback(
    async (directory: string): Promise<SkillSummary[]> => {
      const found = new Map<string, SkillSummary>();
      for (const provider of ['Claude Code', 'Codex'] as const) {
        const catalog = await window.nesvo
          .discoverSkills({ provider, directory }, editorHostId)
          .catch(() => null);
        for (const skill of catalog?.skills ?? [])
          if (!found.has(skill.name))
            found.set(skill.name, {
              id: skill.id,
              name: skill.name,
              description: skill.description,
              source: skill.source,
            });
      }
      return [...found.values()];
    },
    [editorHostId],
  );
  const editorRun = workflowsEditor?.workflowName
    ? store.workflowRuns
        .filter(
          run =>
            run.hostId === workflowsEditor.hostId &&
            run.workflow.name === workflowsEditor.workflowName &&
            (!workflowsEditor.directory ||
              run.projectRoot === workflowsEditor.directory ||
              run.directory === workflowsEditor.directory),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    : undefined;
  const editorRunOverlay = editorRun
    ? {
        run: editorRun,
        steps: store.workflowSteps.filter(
          step =>
            step.runId === editorRun.id && step.hostId === editorRun.hostId,
        ),
      }
    : undefined;
  const cardTrigger = useRef<HTMLElement | null>(null);
  const [workflowPending, setWorkflowPending] = useState<
    Record<string, boolean>
  >({});
  const [workflowErrors, setWorkflowErrors] = useState<Record<string, string>>(
    {},
  );
  const workflowRequests = useRef(new Set<string>());
  const [diffTarget, setDiffTarget] = useState<{
    reviewId: string;
    path?: string;
  } | null>(location.diff);
  const diffTrigger = useRef<HTMLElement | null>(null);
  const [reviewFeedbacks, setReviewFeedbacks] = useState<
    Record<string, string>
  >({});
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [reviewPending, setReviewPending] = useState<Record<string, boolean>>(
    {},
  );
  const reviewRequests = useRef(new Set<string>());
  const reviewAttempts = useRef<Record<string, DecideReviewInput>>({});
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const visibleSidebarWidth = clampSidebarWidth(sidebarWidth, viewportWidth);
  const sidebarToggle = useRef<HTMLButtonElement | null>(null);
  const navigationToggle = useRef<HTMLButtonElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creationGroup, setCreationGroup] = useState<{
    hostId: string;
    groupId: string;
  } | null>(null);
  const threadRequest = useRef(false);
  const pendingCreation = useRef<{
    fingerprint: string;
    requestId: string;
  } | null>(null);
  const navigationVersion = useRef(0);
  const [threadSetup, setThreadSetup] = useState<ThreadSetup>(() =>
    applyNewSessionDefaults({
      hostId: 'local',
      provider: 'Claude Code',
      model: 'default',
      effort: '',
      mode: 'read-only',
      directory: '',
    }),
  );
  const [accountSettingsHostId, setAccountSettingsHostId] = useState<string>();
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts);
  useEffect(() => writeDrafts(drafts), [drafts]);
  const [seen, setSeen] = useState<Record<string, number>>(readSeen);
  useEffect(() => writeSeen(seen), [seen]);
  const [seenSeeded, setSeenSeeded] = useState(false);
  if (!seenSeeded && store.sessions.length > 0) {
    setSeenSeeded(true);
    if (Object.keys(seen).length === 0)
      setSeen(
        Object.fromEntries(
          store.sessions.map(session => [entityKey(session), session.revision]),
        ),
      );
  }
  const [selectedSkills, setSelectedSkills] = useState<
    Record<string, SelectedSkill | null>
  >({});
  const [modelSelections, setModelSelections] = useState<
    Record<string, ModelSelection | null>
  >({});
  const clearModelSelection = (key: string, sent: ModelSelection | null) =>
    setModelSelections(previous =>
      sent && previous[key] === sent ? { ...previous, [key]: null } : previous,
    );
  const [modeSelections, setModeSelections] = useState<
    Record<string, SessionMode | null>
  >({});
  const clearModeSelection = (key: string, sent: SessionMode | null) =>
    setModeSelections(previous =>
      sent && previous[key] === sent ? { ...previous, [key]: null } : previous,
    );
  const supportsSessionWorkflow = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('session-workflow');
  const supportsMcp = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('mcp-servers');
  const supportsSessionFork = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('session-fork');
  const supportsCompaction = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('conversation-compaction');
  const supportsInlineAttachments = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('inline-attachments');
  const supportsModes = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('permission-modes');
  const pendingModeOf = (target: Session) =>
    supportsModes(target.hostId)
      ? (modeSelections[entityKey(target)] ?? null)
      : null;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [restartTarget, setRestartTarget] = useState<Session | null>(null);
  const [forkTarget, setForkTarget] = useState<Session | null>(null);
  const [restartError, setRestartError] = useState('');
  const [compactTarget, setCompactTarget] = useState<Session | null>(null);
  const [compactError, setCompactError] = useState('');
  const [finishingWorktree, setFinishingWorktree] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [moveTarget, setMoveTarget] = useState<Session | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [threadActionPending, setThreadActionPending] = useState(false);
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
    Record<
      string,
      {
        text: string;
        skillId?: string;
        skillHash?: string;
        selection: ModelSelection | null;
        mode: SessionMode | null;
        attachmentIds: string;
        messageId: string;
      }
    >
  >({});
  const composerAttachments = useComposerAttachments();
  const stopping = useRef(new Set<string>());
  const automations = useScheduledJobs(store.computers);
  const jobOf = (
    session: Pick<Session, 'scheduledJobId' | 'hostId' | 'workflowRunId'>,
  ) =>
    session.scheduledJobId
      ? automations.jobs.find(
          job =>
            job.id === session.scheduledJobId && job.hostId === session.hostId,
        )
      : session.workflowRunId
        ? automations.jobs.find(
            job =>
              job.hostId === session.hostId &&
              automations
                .runs(job)
                .runs.some(run => run.workflowRunId === session.workflowRunId),
          )
        : undefined;
  const isAutomationSession = (session: Session) =>
    !!session.scheduledJobId || !!jobOf(session);
  const automationErrorKey = (session: Session) => {
    const job = jobOf(session);
    return job
      ? entityKey(job)
      : hostKey(session.scheduledJobId ?? '', session.hostId);
  };
  const automationLabel = (session: Session) => {
    const name = jobOf(session)?.name;
    return name ? `Automation ${name}` : 'An automation';
  };
  const selected =
    store.sessions.find(session => entityKey(session) === selectedId) ??
    store.sessions[0];
  const selectedKey = selected ? entityKey(selected) : '';
  const selectedLoaded = !!selected;
  const { openSession, loadEarlier } = store;
  useEffect(() => {
    if (selectedLoaded) openSession(selectedKey);
  }, [openSession, selectedKey, selectedLoaded]);
  const targetMissing =
    !!messageTarget &&
    !!selected &&
    hasEarlierMessages(selected) &&
    !selected.messages.some(message => message.id === messageTarget.id);
  const selectedFirstMessage = selected?.messages[0]?.id ?? '';
  useEffect(() => {
    if (!targetMissing) return;
    void loadEarlier(selectedKey).catch(() => undefined);
  }, [targetMissing, selectedFirstMessage, selectedKey, loadEarlier]);
  const selectedRevision = selected?.revision ?? 0;
  const selectedVisible = !browsing && !creating;
  const markSeen = useCallback(() => {
    if (!selectedKey || !selectedVisible || !document.hasFocus()) return;
    setSeen(previous => {
      if (previous[selectedKey] === selectedRevision) return previous;
      const next = { ...previous };
      delete next[selectedKey];
      next[selectedKey] = selectedRevision;
      return next;
    });
  }, [selectedKey, selectedRevision, selectedVisible]);
  useEffect(() => {
    markSeen();
    window.addEventListener('focus', markSeen);
    return () => window.removeEventListener('focus', markSeen);
  }, [markSeen]);
  const unreadKeys = new Set(
    store.sessions
      .filter(session => {
        if (session.revision <= (seen[entityKey(session)] ?? 0)) return false;
        return (
          session.messages.at(-1)?.author === 'agent' ||
          ['completed', 'failed', 'interrupted', 'stopped'].includes(
            session.status,
          ) ||
          session.pendingApprovals.length > 0 ||
          session.delegations.some(item => item.status === 'pending')
        );
      })
      .map(entityKey),
  );
  useAttention(store.sessions, key => selectNow(key));
  const selectedHostId = selected?.hostId ?? 'local';
  const profileCatalog = useProviderProfiles(store.computers);
  const profilesFor = (hostId: string) =>
    profileCatalog.catalogs[hostId]?.profiles ?? [];
  const accountLabel = (session: Session) => {
    const profiles = profilesFor(session.hostId).filter(
      profile => profile.provider === session.provider,
    );
    if (!profiles.length) return undefined;
    return session.profileId
      ? profiles.find(profile => profile.id === session.profileId)?.label
      : 'Default account';
  };
  const selectedAccount = selected ? accountLabel(selected) : undefined;
  const settingsComputer =
    store.computers.find(computer => computer.id === accountSettingsHostId) ??
    store.computers.find(
      computer =>
        computer.id === (creating ? threadSetup.hostId : selectedHostId),
    );
  const settingsHostId = settingsComputer?.id ?? 'local';
  const settingsComputerSelect = store.computers.length > 1 && (
    <Select value={settingsHostId} onValueChange={setAccountSettingsHostId}>
      <SelectTrigger aria-label="Account computer" className="w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {store.computers.map(computer => (
          <SelectItem key={computer.id} value={computer.id}>
            {computer.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const selectedComputer = store.computers.find(
    computer => computer.id === selectedHostId,
  );
  const usageTerminal =
    store.sessions
      .filter(
        session =>
          session.hostId === selectedHostId &&
          (session.profileId ?? null) === (selected?.profileId ?? null),
      )
      .flatMap(session =>
        session.messages
          .filter(message => message.author === 'agent' && message.completedAt)
          .map(message => `${message.completedAt}/${message.runId}`),
      )
      .sort()
      .at(-1) ?? '';
  const usage = useProviderUsage(
    selectedHostId,
    store.hostReady(selectedHostId),
    window.nesvo ? desktopApi(selectedHostId) : undefined,
    usageTerminal,
    selected?.profileId
      ? { id: selected.profileId, provider: selected.provider }
      : undefined,
  );
  const usageProps = {
    hostId: selectedHostId,
    computerName: selectedComputer?.name ?? 'Local',
    connected: store.hostReady(selectedHostId),
    states: usage.states,
    onRefresh: () => void usage.refresh(),
  };
  const connection = store.hostReady(selectedHostId)
    ? 'ready'
    : selectedComputer?.status === 'connecting' ||
        selectedComputer?.status === 'syncing'
      ? 'connecting'
      : 'unavailable';
  const parentSession = store.sessions.find(
    session =>
      session.id === selected?.parentId && session.hostId === selected?.hostId,
  );
  const workers = store.sessions.filter(
    session =>
      session.parentId === selected?.id && session.hostId === selected?.hostId,
  );
  const selectedProfileStatus = useProfileStatus(
    window.nesvo ? desktopApi(selectedHostId) : undefined,
    selectedHostId,
    selected?.provider ?? 'Claude Code',
    selected?.profileId,
    store.hostReady(selectedHostId),
  );
  const hostProviderStates = store.providerStates(selectedHostId);
  const sessionStatuses = selected?.profileId
    ? {
        ...hostProviderStates,
        [selected.provider]: selectedProfileStatus.state,
      }
    : hostProviderStates;
  const selectedProviderState = selected
    ? sessionStatuses[selected.provider]
    : undefined;
  const activeRun = store.sessions.find(
    session =>
      session.hostId === selectedHostId &&
      (session.status === 'running' || session.status === 'stopping'),
  );
  const diffReview =
    !browsing && diffTarget
      ? store.reviews.find(
          review =>
            review.id === diffTarget.reviewId &&
            review.sessionId === selected?.id &&
            review.hostId === selectedHostId,
        )
      : undefined;
  const selectedRun = selected?.workflowRunId
    ? store.workflowRuns.find(
        run =>
          run.id === selected.workflowRunId && run.hostId === selectedHostId,
      )
    : undefined;
  const selectedRunSteps = selectedRun
    ? store.workflowSteps.filter(
        step => step.runId === selectedRun.id && step.hostId === selectedHostId,
      )
    : [];
  const visiblePanel = panel === 'diff' && !diffReview ? null : panel;
  const cardSession = !browsing && !creating && selected ? selected : null;
  const cardRun = cardSession ? selectedRun : undefined;
  useEffect(() => {
    if (
      store.loading ||
      store.error ||
      store.reviewsLoading ||
      store.reviewsError
    )
      return;
    saveWorkspaceLocation({
      selectedId: selectedKey,
      inbox,
      automation,
      diff: !inbox && panel === 'diff' && diffReview ? diffTarget : null,
    });
  }, [
    selectedKey,
    inbox,
    automation,
    panel,
    diffReview,
    diffTarget,
    store.loading,
    store.error,
    store.reviewsLoading,
    store.reviewsError,
  ]);
  useEffect(() => {
    saveSidebarOpen(sidebarOpen);
  }, [sidebarOpen]);
  useEffect(() => {
    saveSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const toggleSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open);
    requestAnimationFrame(() => sidebarToggle.current?.focus());
  }, []);
  const openHistorySearch = useCallback((query = '') => {
    const focused = document.activeElement;
    setHistorySearch(
      current =>
        current ?? {
          query: query.slice(0, 200),
          returnFocus: focused instanceof HTMLElement ? focused : null,
        },
    );
  }, []);
  const openPalette = useCallback((mode: PaletteMode) => {
    const focused = document.activeElement;
    setPalette(
      current =>
        current ?? {
          mode,
          returnFocus: focused instanceof HTMLElement ? focused : null,
        },
    );
  }, []);
  useEffect(() => {
    saveSessionFilter(sessionFilter);
  }, [sessionFilter]);
  useEffect(() => {
    const last = lastSelection.current;
    if (!selectedKey || selectedKey === last.current) return;
    lastSelection.current = { current: selectedKey, previous: last.current };
  }, [selectedKey]);
  const filterKeys = useMemo(
    () => sessionFilterKeys(store.sessions, store.reviews, store.workflowRuns),
    [store.sessions, store.reviews, store.workflowRuns],
  );
  useBackgroundAttention(store.sessions, filterKeys['needs-me'], key =>
    select(key),
  );
  const panelTrigger = () =>
    cardOpen
      ? cardTrigger.current
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  const openDiff = (reviewId: string, path?: string) => {
    diffTrigger.current = panelTrigger();
    setCardOpen(false);
    setDiffTarget({ reviewId, path });
    setPanel('diff');
  };
  const openFiles = () => {
    diffTrigger.current = panelTrigger();
    setCardOpen(false);
    if (!diffReview) {
      const latest = store.reviews
        .filter(
          review =>
            review.sessionId === selected?.id &&
            review.hostId === selectedHostId,
        )
        .sort((a, b) => b.version - a.version)[0];
      setDiffTarget(latest ? { reviewId: latest.id } : null);
    }
    setPanel('files');
  };
  const closeCard = () => {
    setCardOpen(false);
    const trigger = cardTrigger.current;
    requestAnimationFrame(() => {
      const target = trigger?.isConnected
        ? trigger
        : document.querySelector<HTMLElement>('[data-session-card-trigger]');
      target?.focus();
    });
  };
  const openCard = (trigger: HTMLElement | null) => {
    cardTrigger.current = trigger;
    if (selectedRun)
      setWorkflowErrors(previous => ({
        ...previous,
        [entityKey(selectedRun)]: '',
      }));
    setCardOpen(true);
  };
  const toggleCard = (trigger: HTMLElement) => {
    if (cardOpen) {
      closeCard();
      return;
    }
    openCard(trigger);
  };
  const closeDiff = () => {
    setPanel(null);
    setDiffTarget(null);
    const trigger = diffTrigger.current;
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };
  const guardEditor = (proceed: () => void) => {
    if (workflowsView && workflowsEditor && editorDirty)
      setLeaveEditor(() => proceed);
    else proceed();
  };
  const select = (id: string, targetId = '') => {
    guardEditor(() => selectNow(id, targetId));
  };
  const selectNow = (id: string, targetId = '') => {
    navigationVersion.current += 1;
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setSelectedId(id);
    setSessionTarget(targetId);
    setMessageTarget(null);
    setInbox(false);
    setCostsView(false);
    setWorkflowsView(false);
    setPullRequestsView(false);
    setAutomation('');
    setNavigationOpen(false);
    setDetailsOpen(false);
  };
  const openInbox = () => guardEditor(openInboxNow);
  const openInboxNow = () => {
    navigationVersion.current += 1;
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(true);
    setCostsView(false);
    setWorkflowsView(false);
    setPullRequestsView(false);
    setAutomation('');
    setNavigationOpen(false);
  };
  const openWorkflows = () => guardEditor(openWorkflowsNow);
  const openWorkflowsNow = () => {
    navigationVersion.current += 1;
    setWorkflowsSource(
      creating || !selected
        ? { hostId: threadSetup.hostId, directory: threadSetup.directory }
        : { hostId: selected.hostId, directory: selected.directory },
    );
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(false);
    setCostsView(false);
    setWorkflowsEditor(null);
    setAutomation('');
    setWorkflowsView(true);
    setPullRequestsView(false);
    setNavigationOpen(false);
  };
  const openPullRequests = () => guardEditor(openPullRequestsNow);
  const openPullRequestsNow = (handoff: Session | null = null) => {
    navigationVersion.current += 1;
    if (handoff || panel !== 'pull-request') setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(false);
    setCostsView(false);
    setWorkflowsEditor(null);
    setWorkflowsView(false);
    setAutomation('');
    setPullRequestsView(true);
    setPullRequestHandoff(handoff);
    setNavigationOpen(false);
    setDetailsOpen(false);
  };
  const openPullRequest = (target: PullRequestTarget) => {
    diffTrigger.current = panelTrigger();
    setCardOpen(false);
    setPullRequestTarget(target);
    setPanel('pull-request');
  };
  const openAutomations = (target = 'list') =>
    guardEditor(() => openAutomationsNow(target));
  const openAutomationsNow = (target: string) => {
    navigationVersion.current += 1;
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(false);
    setCostsView(false);
    setWorkflowsEditor(null);
    setWorkflowsView(false);
    setPullRequestsView(false);
    setAutomation(target);
    setNavigationOpen(false);
    setDetailsOpen(false);
  };
  const openCreate = () =>
    guardEditor(() => {
      setCreationGroup(null);
      setThreadSetup(previous => applyNewSessionDefaults(previous));
      openCreateNow();
    });
  const openCreateInGroup = (hostId: string, group: SessionGroup) =>
    guardEditor(() => {
      const { directory, provider, model, mode, profileId } = group.defaults;
      setThreadSetup(current => {
        const defaults = readNewSessionDefaults();
        const previous = applyNewSessionDefaults(
          { ...current, hostId },
          defaults,
        );
        const switched = !!provider && provider !== previous.provider;
        return {
          ...previous,
          hostId,
          directory: directory ?? previous.directory,
          provider: provider ?? previous.provider,
          profileId:
            profileId === undefined
              ? (defaults.profileIds[
                  defaultProfileKey(hostId, provider ?? previous.provider)
                ] ?? null)
              : profileId,
          model: model ?? (switched ? '' : previous.model),
          effort: switched || model ? '' : previous.effort,
          mode: mode ?? (switched ? 'read-only' : previous.mode),
        };
      });
      setCreationGroup({ hostId, groupId: group.id });
      openCreateNow();
    });
  const openCreateNow = () => {
    navigationVersion.current += 1;
    setNavigationOpen(false);
    setDetailsOpen(false);
    setPanel(null);
    setDiffTarget(null);
    setInbox(false);
    setCostsView(false);
    setWorkflowsView(false);
    setPullRequestsView(false);
    setAutomation('');
    setCreating(true);
  };
  const openCosts = () =>
    guardEditor(() => {
      navigationVersion.current += 1;
      setPanel(null);
      setDiffTarget(null);
      setCreating(false);
      setInbox(false);
      setWorkflowsEditor(null);
      setWorkflowsView(false);
      setPullRequestsView(false);
      setAutomation('');
      setNavigationOpen(false);
      setDetailsOpen(false);
      setCardOpen(false);
      setCostsView(true);
    });
  const changeDraft = (id: string, value: string) => {
    draftVersions.current[id] = (draftVersions.current[id] ?? 0) + 1;
    setDrafts(previous => ({ ...previous, [id]: value }));
  };
  const changeSkill = (id: string, skill: SelectedSkill | null) => {
    draftVersions.current[id] = (draftVersions.current[id] ?? 0) + 1;
    setSelectedSkills(previous => ({ ...previous, [id]: skill }));
  };
  const deliver = async (
    target: Session,
    text: string,
    skill: SelectedSkill | null,
    onAcknowledge: () => void,
    queued = false,
    selection: ModelSelection | null = null,
    mode: SessionMode | null = null,
    attachments: readonly MessageAttachment[] = [],
  ) => {
    const sessionId = target.id;
    const attachmentIds = attachments
      .map(item => `${item.id}@${item.offset ?? ''}`)
      .join();
    const sessionKey = entityKey(target);
    const hostId = target.hostId;
    const skillId = skill?.id;
    const skillHash = skill?.contentHash;
    const prior = sendAttempts.current[sessionKey];
    const attempt =
      prior?.text === text &&
      prior.skillId === skillId &&
      prior.skillHash === skillHash &&
      prior.selection?.model === selection?.model &&
      prior.selection?.effort === selection?.effort &&
      prior.mode === mode &&
      prior.attachmentIds === attachmentIds
        ? prior
        : {
            text,
            skillId,
            skillHash,
            selection,
            mode,
            attachmentIds,
            messageId: crypto.randomUUID(),
          };
    sendAttempts.current[sessionKey] = attempt;
    sendingRef.current = true;
    setSending(true);
    setErrors(previous => ({ ...previous, [sessionKey]: '' }));
    const acknowledge = () => {
      delete sendAttempts.current[sessionKey];
      onAcknowledge();
    };
    try {
      const api = desktopApi(hostId);
      const session = await (queued ? api.queueMessage : api.sendMessage)({
        sessionId,
        messageId: attempt.messageId,
        text,
        ...(skillId ? { skillId } : {}),
        ...(skillHash ? { skillHash } : {}),
        ...(selection
          ? { model: selection.model, effort: selection.effort }
          : {}),
        ...(mode ? { mode } : {}),
        ...(attachments.length
          ? {
              attachments: supportsInlineAttachments(hostId)
                ? [...attachments]
                : attachments.map(withoutPlacement),
            }
          : {}),
      });
      store.merge([session]);
      acknowledge();
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [sessionKey]: `Could not confirm that the message was sent. ${errorDetail(failure)}`,
      }));
      try {
        const history = await store.recover(hostId);
        const recovered = history.find(session => session.id === sessionId);
        if (
          recovered?.messages.some(
            message => message.id === attempt.messageId,
          ) ||
          recovered?.queue.some(item => item.id === attempt.messageId)
        )
          acknowledge();
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [sessionKey]: `${previous[sessionKey] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)} You can retry the same message.`,
        }));
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const send = async (typed?: { text: string; skill: SelectedSkill }) => {
    if (!selected || sendingRef.current || connection !== 'ready') return;
    if (
      !activeRun &&
      (selectedProviderState?.status?.status !== 'ready' ||
        selectedProviderState.loading ||
        selectedProviderState.error)
    )
      return;
    const sessionKey = entityKey(selected);
    const draft = drafts[sessionKey] ?? '';
    const text = typed?.text ?? draft.trim();
    if (!text || text.length > 32000) return;
    if (composerAttachments.pending(sessionKey)) return;
    const attachments = placeInText(
      composerAttachments.ready(sessionKey),
      Math.max(0, draft.indexOf(text)),
      text.length,
    );
    const version = draftVersions.current[sessionKey] ?? 0;
    const skill = typed?.skill ?? selectedSkills[sessionKey] ?? null;
    const selection = modelSelections[sessionKey] ?? null;
    const mode = pendingModeOf(selected);
    await deliver(
      selected,
      text,
      skill,
      () => {
        clearModelSelection(sessionKey, selection);
        clearModeSelection(sessionKey, mode);
        composerAttachments.clear(sessionKey, attachments);
        if ((draftVersions.current[sessionKey] ?? 0) === version) {
          setDrafts(previous => ({ ...previous, [sessionKey]: '' }));
          setSelectedSkills(previous => ({ ...previous, [sessionKey]: null }));
        }
      },
      !!activeRun,
      selection,
      mode,
      attachments,
    );
  };
  const resend = async () => {
    if (!selected || sendingRef.current || connection !== 'ready' || activeRun)
      return;
    const last = selected.messages.findLast(
      message => message.author === 'operator',
    );
    if (!last) return;
    const sessionKey = entityKey(selected);
    const selection = modelSelections[sessionKey] ?? null;
    const mode = pendingModeOf(selected);
    delete sendAttempts.current[sessionKey];
    await deliver(
      selected,
      last.body,
      null,
      () => {
        clearModelSelection(sessionKey, selection);
        clearModeSelection(sessionKey, mode);
      },
      false,
      selection,
      mode,
      last.attachments,
    );
  };
  const changeQueued = async (
    target: Session,
    messageId: string,
    action: 'cancel' | 'start',
  ) => {
    const key = entityKey(target);
    const api = desktopApi(target.hostId);
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      const input = { sessionId: target.id, messageId };
      store.merge([
        await (action === 'cancel'
          ? api.cancelQueued(input)
          : api.startQueued(input)),
      ]);
      return true;
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `${action === 'cancel' ? 'Could not remove the queued message.' : 'Could not send the queued message.'} ${errorDetail(failure)}`,
      }));
      return false;
    }
  };
  const editQueued = async (
    target: Session,
    messageId: string,
    text: string,
  ) => {
    const entry = target.queue.find(item => item.id === messageId);
    if (!(await changeQueued(target, messageId, 'cancel'))) return;
    const key = entityKey(target);
    changeDraft(key, text);
    if (entry?.attachments) composerAttachments.restore(key, entry.attachments);
    const model = entry?.model;
    if (model)
      setModelSelections(previous => ({
        ...previous,
        [key]: { model, effort: entry.effort ?? null },
      }));
    const mode = entry?.mode;
    if (mode)
      setModeSelections(previous => ({
        ...previous,
        [key]: mode === target.mode ? null : mode,
      }));
  };
  const startThread = async (
    input: CreateSessionInput,
    text: string,
    skill: SelectedSkill | null,
  ) => {
    const hostId = threadSetup.hostId;
    if (threadRequest.current || sendingRef.current)
      throw new Error('Another thread is still starting.');
    if (!store.hostReady(hostId))
      throw new Error('Connect this computer before starting a thread.');
    threadRequest.current = true;
    const origin = navigationVersion.current;
    const group =
      creationGroup?.hostId === hostId && store.supportsGroups(hostId)
        ? store.groups(hostId).find(item => item.id === creationGroup.groupId)
        : undefined;
    try {
      const fingerprint = JSON.stringify([
        origin,
        hostId,
        input,
        text,
        skill?.id,
        skill?.contentHash,
      ]);
      if (pendingCreation.current?.fingerprint !== fingerprint)
        pendingCreation.current = {
          fingerprint,
          requestId: crypto.randomUUID(),
        };
      const session = await desktopApi(hostId).createSession({
        ...input,
        ...(group ? { groupId: group.id } : {}),
        requestId: pendingCreation.current.requestId,
      });
      pendingCreation.current = null;
      store.merge([session]);
      setCreationGroup(null);
      const workflow = group?.defaults.workflow;
      if (workflow && supportsSessionWorkflow(hostId))
        await assignWorkflow(session, workflow);
      const key = entityKey(session);
      draftVersions.current[key] = (draftVersions.current[key] ?? 0) + 1;
      const version = draftVersions.current[key];
      setDrafts(previous => ({ ...previous, [key]: text }));
      setSelectedSkills(previous => ({ ...previous, [key]: skill }));
      if (navigationVersion.current === origin) select(key);
      await deliver(session, text, skill, () => {
        if ((draftVersions.current[key] ?? 0) === version) {
          setDrafts(previous => ({ ...previous, [key]: '' }));
          setSelectedSkills(previous => ({ ...previous, [key]: null }));
        }
      });
    } finally {
      threadRequest.current = false;
    }
  };
  const startWorkflowTask = async (
    input: StartWorkflowTaskInput,
  ): Promise<'opened' | 'started'> => {
    const hostId = threadSetup.hostId;
    if (threadRequest.current || sendingRef.current)
      throw new Error('Another thread is still starting.');
    if (!store.hostReady(hostId))
      throw new Error('Connect this computer before starting a task.');
    threadRequest.current = true;
    const origin = navigationVersion.current;
    let run: Awaited<ReturnType<typeof window.nesvo.workflows.startTask>>;
    try {
      run = await window.nesvo.workflows.startTask(hostId, input);
    } finally {
      threadRequest.current = false;
    }
    store.mergeWorkflowRuns([run]);
    if (!run.sessionId) return 'started';
    try {
      const history = await store.recover(hostId);
      const session = history.find(item => item.id === run.sessionId);
      if (!session || navigationVersion.current !== origin) return 'started';
      select(entityKey(session));
      return 'opened';
    } catch {
      return 'started';
    }
  };
  const controlWorkflow = async (
    action: 'stop' | 'resume' | 'confirm',
    stepId = '',
  ) => {
    if (!selectedRun || !store.hostReady(selectedRun.hostId)) return;
    const run = selectedRun;
    const key = entityKey(run);
    if (workflowRequests.current.has(key)) return;
    workflowRequests.current.add(key);
    setWorkflowPending(previous => ({ ...previous, [key]: true }));
    setWorkflowErrors(previous => ({ ...previous, [key]: '' }));
    try {
      store.mergeWorkflowRuns([
        action === 'stop'
          ? await window.nesvo.workflows.stopRun(run.hostId, run.id)
          : action === 'resume'
            ? await window.nesvo.workflows.resumeRun(run.hostId, run.id)
            : await window.nesvo.workflows.skipStep(run.hostId, {
                runId: run.id,
                stepId,
                reason: 'The operator confirmed that the action already ran.',
              }),
      ]);
    } catch (failure) {
      setWorkflowErrors(previous => ({
        ...previous,
        [key]: `Could not ${action === 'stop' ? 'stop the workflow' : action === 'resume' ? 'resume the workflow' : 'record the decision'}. ${errorDetail(failure)}`,
      }));
    } finally {
      workflowRequests.current.delete(key);
      setWorkflowPending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  const hostRun = store.sessions.find(
    session =>
      session.hostId === threadSetup.hostId &&
      (session.status === 'running' || session.status === 'stopping'),
  );
  const threadBusyReason =
    store.loading || store.error
      ? 'Session history is still loading.'
      : hostRun && isAutomationSession(hostRun)
        ? `${automationLabel(hostRun)} is running on this computer.`
        : hostRun
          ? 'Another session is working on this computer.'
          : '';
  const stop = async (target: Session | undefined = selected) => {
    if (
      !target?.runId ||
      !store.hostReady(target.hostId) ||
      target.status !== 'running' ||
      stopping.current.has(hostKey(target.runId, target.hostId))
    )
      return '';
    const { id: sessionId, runId } = target;
    const key = entityKey(target);
    const runKey = hostKey(runId, target.hostId);
    stopping.current.add(runKey);
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      store.merge([
        await desktopApi(target.hostId).stopRun({ sessionId, runId }),
      ]);
    } catch (failure) {
      const message = `Could not stop the run. ${errorDetail(failure)}`;
      setErrors(previous => ({ ...previous, [key]: message }));
      try {
        await store.recover(target.hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [key]: `${previous[key] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
        }));
      }
      return message;
    } finally {
      stopping.current.delete(runKey);
    }
    return '';
  };
  const respondApproval = async (
    input: RespondApprovalInput,
    hostId = 'local',
  ) => {
    const session = store.sessions.find(
      item => item.id === input.sessionId && item.hostId === hostId,
    );
    const approval = session?.pendingApprovals.find(
      item => item.id === input.requestId,
    );
    if (
      !session ||
      !approval ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      !store.hostReady(hostId) ||
      store.loading ||
      store.error
    )
      return;
    const { sessionId, runId, requestId } = input;
    const key = `${hostKey(sessionId, hostId)}/${runId}/${requestId}`;
    if (approvalRequests.current.has(key)) return;
    approvalRequests.current.add(key);
    setApprovalPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [hostKey(sessionId, hostId)]: '' }));
    try {
      store.merge([
        await desktopApi(hostId).respondApproval({
          ...input,
          ...(approval.fingerprint
            ? { fingerprint: approval.fingerprint }
            : {}),
        }),
      ]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [hostKey(sessionId, hostId)]:
          `Could not send the decision. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover(hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [hostKey(sessionId, hostId)]:
            `${previous[hostKey(sessionId, hostId)] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
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
    input: DecideDelegationInput,
    hostId = 'local',
  ) => {
    const session = store.sessions.find(
      item => item.id === input.sessionId && item.hostId === hostId,
    );
    if (
      !session ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      !store.hostReady(hostId) ||
      store.loading ||
      store.error ||
      !session.delegations.some(
        delegation =>
          delegation.id === input.delegationId &&
          delegation.runId === input.runId &&
          delegation.status === 'pending',
      )
    )
      return;
    const { sessionId, runId, delegationId } = input;
    const key = `${hostKey(sessionId, hostId)}/${runId}/${delegationId}`;
    if (delegationRequests.current.has(key)) return;
    delegationRequests.current.add(key);
    setDelegationPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [hostKey(sessionId, hostId)]: '' }));
    try {
      store.merge([await desktopApi(hostId).decideDelegation(input)]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [hostKey(sessionId, hostId)]:
          `Could not send the worker decision. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover(hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [hostKey(sessionId, hostId)]:
            `${previous[hostKey(sessionId, hostId)] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
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
  const decideWorkerPlan = async (
    input: DecideWorkerPlanInput,
    hostId = 'local',
  ) => {
    const session = store.sessions.find(
      item => item.id === input.sessionId && item.hostId === hostId,
    );
    if (
      !session ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      !store.hostReady(hostId) ||
      store.loading ||
      store.error ||
      !session.delegations.some(
        delegation =>
          delegation.id === input.delegationId &&
          delegation.runId === input.runId &&
          delegation.status === 'plan-ready',
      )
    )
      return;
    const { sessionId, runId, delegationId } = input;
    const key = `${hostKey(sessionId, hostId)}/${runId}/${delegationId}`;
    if (delegationRequests.current.has(key)) return;
    delegationRequests.current.add(key);
    setDelegationPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [hostKey(sessionId, hostId)]: '' }));
    try {
      store.merge([await desktopApi(hostId).decideWorkerPlan(input)]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [hostKey(sessionId, hostId)]:
          `Could not send the plan decision. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover(hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [hostKey(sessionId, hostId)]:
            `${previous[hostKey(sessionId, hostId)] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
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
  const reviewBlockedReason = (review: Review) =>
    !store.hostReady(review.hostId)
      ? 'Connect this computer and sync its history before making a decision.'
      : store.sessions.some(
            session =>
              session.hostId === review.hostId &&
              (session.status === 'running' || session.status === 'stopping'),
          ) || sending
        ? 'Result review is available once this computer’s sessions and workers finish.'
        : '';
  const decideReview = async (
    review: Review,
    decision: DecideReviewInput['decision'],
    feedback: string,
  ) => {
    const key = entityKey(review);
    if (reviewRequests.current.has(key) || reviewBlockedReason(review)) return;
    if (
      review.status !== 'pending' ||
      (decision === 'accept' && review.diff.status === 'unavailable') ||
      (decision === 'request-changes' && !feedback.trim())
    )
      return;
    const prior = reviewAttempts.current[key];
    const attempt =
      prior?.version === review.version &&
      prior.decision === decision &&
      prior.feedback === feedback.trim()
        ? prior
        : {
            reviewId: review.id,
            version: review.version,
            decisionId: crypto.randomUUID(),
            decision,
            feedback: feedback.trim(),
          };
    reviewAttempts.current[key] = attempt;
    reviewRequests.current.add(key);
    setReviewPending(previous => ({ ...previous, [key]: true }));
    setReviewErrors(previous => ({ ...previous, [key]: '' }));
    const acknowledge = (result: Review) => {
      store.mergeReviews([result]);
      setReviewErrors(previous => ({ ...previous, [key]: '' }));
      delete reviewAttempts.current[key];
      if (attempt.decision === 'request-changes') {
        select(hostKey(result.sessionId, result.hostId));
        void store.recover(review.hostId).catch(failure =>
          setErrors(previous => ({
            ...previous,
            [hostKey(result.sessionId, result.hostId)]:
              `The correction was requested, but the conversation could not be refreshed. ${errorDetail(failure)}`,
          })),
        );
      }
    };
    try {
      acknowledge(await desktopApi(review.hostId).decideReview(attempt));
    } catch (failure) {
      setReviewErrors(previous => ({
        ...previous,
        [key]: `Could not save the decision. ${errorDetail(failure)}`,
      }));
      try {
        const history = await store.recoverReviews(review.hostId);
        const confirmed = history.find(
          result =>
            result.id === review.id &&
            result.decision?.id === attempt.decisionId,
        );
        if (confirmed) acknowledge(confirmed);
      } catch (recoveryFailure) {
        setReviewErrors(previous => ({
          ...previous,
          [key]: `${previous[key] ?? ''} Could not refresh the results. ${errorDetail(recoveryFailure)} Retrying the same decision will not create a duplicate request.`,
        }));
      }
    } finally {
      reviewRequests.current.delete(key);
      setReviewPending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  const reviewDecisionProps = {
    blockedReason: '',
    getBlockedReason: reviewBlockedReason,
    pending: reviewPending,
    decisionErrors: reviewErrors,
    feedbacks: reviewFeedbacks,
    onFeedback: (reviewId: string, value: string) =>
      setReviewFeedbacks(previous => ({ ...previous, [reviewId]: value })),
    onDecision: (
      review: Review,
      decision: DecideReviewInput['decision'],
      feedback: string,
    ) => void decideReview(review, decision, feedback),
  };
  const runningSessions = store.sessions.filter(
    session => session.status === 'running' || session.status === 'stopping',
  );
  const runningAutomations = runningSessions.filter(isAutomationSession);
  const stopWorkflowRun = async (hostId: string, workflowRunId: string) => {
    try {
      store.mergeWorkflowRuns([
        await window.nesvo.workflows.stopRun(hostId, workflowRunId),
      ]);
      return '';
    } catch (failure) {
      return `Could not stop the workflow. ${errorDetail(failure)}`;
    }
  };
  const stopAutomation = async (session: Session, reportKey = '') => {
    const error =
      !session.scheduledJobId && session.workflowRunId
        ? await stopWorkflowRun(session.hostId, session.workflowRunId)
        : await stop(session);
    if (!error || !isAutomationSession(session)) return;
    setAutomationErrors(previous => ({
      ...previous,
      [automationErrorKey(session)]: error,
    }));
    if (reportKey) setErrors(previous => ({ ...previous, [reportKey]: error }));
  };
  const stopAutomationRun = async (job: ScheduledJob, run: ScheduledJobRun) => {
    if (run.workflowRunId) {
      const error = await stopWorkflowRun(run.hostId, run.workflowRunId);
      if (error)
        setAutomationErrors(previous => ({
          ...previous,
          [entityKey(job)]: error,
        }));
      return;
    }
    const session = store.sessions.find(
      item => item.id === run.sessionId && item.hostId === run.hostId,
    );
    if (session) await stopAutomation(session);
  };
  const automationBusy = (session: Session, reportKey = '') => (
    <>
      {automationLabel(session)} is running ·{' '}
      <Button
        type="button"
        variant="link"
        size="inline"
        disabled={
          session.status !== 'running' || !store.hostReady(session.hostId)
        }
        onClick={() => void stopAutomation(session, reportKey)}
      >
        {session.status === 'stopping' ? 'Stopping…' : 'Stop'}
      </Button>
    </>
  );
  const automationComputers = store.computers.filter(supportsScheduledJobs);
  const automationJob =
    automation && automation !== 'list'
      ? automations.jobs.find(job => entityKey(job) === automation)
      : undefined;
  const automationView = automation
    ? automationJob
      ? 'detail'
      : 'list'
    : null;
  const setAutomationState = (key: string, pending: boolean, error = '') => {
    setAutomationPending(previous => ({ ...previous, [key]: pending }));
    setAutomationErrors(previous => ({ ...previous, [key]: error }));
  };
  const hostOffline = (hostId: string) => {
    const computer = store.computers.find(item => item.id === hostId);
    return store.hostReady(hostId)
      ? ''
      : `${computer?.name ?? 'This computer'} is offline. Connect it to manage this automation.`;
  };
  const runBlockedReason = (job: ScheduledJob) => {
    const offline = hostOffline(job.hostId);
    if (offline) return offline;
    const running = runningSessions.find(
      session => session.hostId === job.hostId,
    );
    if (!running) return '';
    return isAutomationSession(running)
      ? `${automationLabel(running)} is running.`
      : 'Another session is working on this computer.';
  };
  const runAutomationNow = async (job: ScheduledJob) => {
    const key = entityKey(job);
    if (automationPending[key] || runBlockedReason(job)) return;
    const prior = runRequests.current[key];
    const settled =
      !prior ||
      automations
        .runs(job)
        .runs.some(
          run => run.trigger === 'manual' && (run.startedAt ?? '') >= prior.at,
        );
    const request = settled
      ? { id: crypto.randomUUID(), at: new Date().toISOString() }
      : prior;
    runRequests.current[key] = request;
    setAutomationState(key, true);
    try {
      automations.mergeRuns([
        await window.nesvo.scheduledJobs.runNow(job.hostId, job.id, request.id),
      ]);
      delete runRequests.current[key];
      setAutomationState(key, false);
    } catch (failure) {
      const detail = errorDetail(failure);
      if (/busy|not found|already in use/i.test(detail))
        delete runRequests.current[key];
      setAutomationState(key, false, `Could not start the run. ${detail}`);
    }
  };
  const decideAutomationStart = async (
    job: ScheduledJob,
    decision: 'start' | 'skip',
  ) => {
    const key = entityKey(job);
    if (!job.pendingStart || automationPending[key] || hostOffline(job.hostId))
      return;
    setAutomationState(key, true);
    try {
      automations.mergeJobs([
        await window.nesvo.scheduledJobs.decideStart(job.hostId, {
          id: job.id,
          pendingId: job.pendingStart.id,
          decision,
        }),
      ]);
      setAutomationState(key, false);
    } catch (failure) {
      setAutomationState(
        key,
        false,
        `Could not ${decision} the automation. ${errorDetail(failure)}`,
      );
      void automations.reload(job.hostId);
    }
  };
  const setAutomationActive = async (job: ScheduledJob, active: boolean) => {
    const key = entityKey(job);
    if (automationPending[key]) return;
    setAutomationState(key, true);
    try {
      automations.mergeJobs([
        await window.nesvo.scheduledJobs.setActive(
          job.hostId,
          job.id,
          active,
          job.revision,
        ),
      ]);
      setAutomationState(key, false);
    } catch (failure) {
      setAutomationState(
        key,
        false,
        `Could not ${active ? 'resume' : 'pause'} the automation. ${errorDetail(failure)}`,
      );
      void automations.reload(job.hostId);
    }
  };
  const deleteAutomation = async (job: ScheduledJob) => {
    const key = entityKey(job);
    setAutomationState(key, true);
    try {
      await window.nesvo.scheduledJobs.delete(job.hostId, job.id, job.revision);
      automations.removeJob(job);
      setAutomationState(key, false);
      openAutomations();
      return true;
    } catch (failure) {
      setAutomationState(
        key,
        false,
        `Could not delete the automation. ${errorDetail(failure)}`,
      );
      return false;
    }
  };
  const defaultAutomationHost =
    automationComputers.find(computer => store.hostReady(computer.id))?.id ??
    'local';
  const openAutomationEditor = (initial: AutomationValues, jobKey = '') =>
    setEditor({ initial, jobKey });
  const createAutomation = () => {
    const states = store.providerStates(defaultAutomationHost);
    openAutomationEditor(
      newAutomationValues(
        defaultAutomationHost,
        'Claude Code',
        states['Claude Code'].status?.models[0]?.id ?? 'default',
      ),
    );
  };
  const editorJob = editor?.jobKey
    ? (automations.jobs.find(job => entityKey(job) === editor.jobKey) ?? null)
    : null;
  const automationNotices = [
    ...store.computers
      .filter(
        computer =>
          computer.status === 'connected' && !supportsScheduledJobs(computer),
      )
      .map(
        computer =>
          `${computer.name} runs an older Nesvo host. Update it to use automations there.`,
      ),
    ...Object.values(automations.hostErrors).filter(Boolean),
  ];
  const latestRun = (job: ScheduledJob): ScheduledJobRun | undefined =>
    automations.runs(job).runs[0];
  const operationEnabled =
    connection === 'ready' && !store.loading && !store.error;
  const pullRequestsAvailable = store.computers.some(computer =>
    computer.capabilities.includes('pull-requests'),
  );
  const pullRequestBlockedReason = (hostId: string) =>
    pullRequestsUnavailableReason(
      store.computers.find(computer => computer.id === hostId),
    ) || (store.hostReady(hostId) ? '' : 'Session history is still loading.');
  const pullRequestApi = (hostId: string) =>
    window.nesvo ? desktopApi(hostId) : null;
  const linkedSessions = pullRequestTarget
    ? store.sessions.filter(
        session =>
          session.hostId === pullRequestTarget.hostId &&
          sameReference(session.pullRequest, pullRequestTarget.reference),
      )
    : [];
  const checkoutSession =
    selected && linkedSessions.includes(selected) ? selected : null;
  const threadTarget = checkoutSession ?? linkedSessions[0] ?? selected ?? null;
  const sendToSession = (text: string) => {
    if (!threadTarget) return;
    const key = entityKey(threadTarget);
    const existing = drafts[key]?.trim();
    changeDraft(
      key,
      (existing
        ? `${existing}

${text}`
        : text
      ).slice(0, DRAFT_LIMIT_CHARACTERS),
    );
    if (key !== selectedKey || browsing || creating) {
      selectNow(key);
      setPanel('pull-request');
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document.getElementById('message-input')?.focus(),
      ),
    );
  };
  const housekeeping = useHousekeeping(store, openCreateInGroup);
  const forkSession = async (
    target: Session,
    worktree?: ForkSessionInput['worktree'],
  ) => {
    setThreadActionPending(true);
    try {
      const fork = await desktopApi(target.hostId).forkSession({
        sessionId: target.id,
        ...(worktree ? { worktree } : {}),
      });
      store.merge([fork]);
      select(entityKey(fork));
    } catch (error) {
      const key = entityKey(target);
      setErrors(previous => ({ ...previous, [key]: errorDetail(error) }));
      select(key);
    } finally {
      setThreadActionPending(false);
    }
  };
  const chooseFork = async (target: Session) => {
    const supportsWorktree = store.computers
      .find(computer => computer.id === target.hostId)
      ?.capabilities.includes('session-worktree-tools');
    if (supportsWorktree) {
      setThreadActionPending(true);
      try {
        const git =
          target.worktree ||
          (
            await desktopApi(target.hostId).readGitBranch({
              directory: target.directory,
            })
          ).kind !== 'none';
        if (git) {
          setForkTarget(target);
          return;
        }
      } catch {
        await forkSession(target);
        return;
      } finally {
        setThreadActionPending(false);
      }
    }
    await forkSession(target);
  };
  const restartSession = async (target: Session) => {
    setThreadActionPending(true);
    setRestartError('');
    try {
      const session = await desktopApi(target.hostId).restartSession({
        sessionId: target.id,
        revision: target.revision,
      });
      store.merge([session]);
      const key = entityKey(session);
      setErrors(previous => ({ ...previous, [key]: '' }));
      setModeSelections(previous => ({ ...previous, [key]: null }));
      setModelSelections(previous => ({ ...previous, [key]: null }));
      setRestartTarget(null);
      select(key);
      return true;
    } catch (error) {
      setRestartError(errorDetail(error));
      return false;
    } finally {
      setThreadActionPending(false);
    }
  };
  const compactSession = async (target: Session, instructions?: string) => {
    setThreadActionPending(true);
    setCompactError('');
    const key = entityKey(target);
    try {
      const session = await desktopApi(target.hostId).compactSession({
        sessionId: target.id,
        revision: target.revision,
        ...(instructions ? { instructions } : {}),
      });
      store.merge([session]);
      setErrors(previous => ({ ...previous, [key]: '' }));
      return true;
    } catch (error) {
      const detail = `The conversation could not be compacted. ${errorDetail(error)}`;
      if (instructions) setCompactError(detail);
      else setErrors(previous => ({ ...previous, [key]: detail }));
      return false;
    } finally {
      setThreadActionPending(false);
    }
  };
  const managedSession = (session: Session) =>
    session.role === 'worker' ||
    !!session.workflowRunId ||
    !!session.scheduledJobId;
  const threadActionBusy = (session: Session) =>
    threadActionPending ||
    !store.hostReady(session.hostId) ||
    session.status === 'running' ||
    session.status === 'stopping';
  const sessionConversationActions = (session: Session) =>
    !window.nesvo || managedSession(session)
      ? []
      : conversationActions({
          session,
          canCompact: supportsCompaction(session.hostId),
          canRestart: supportsSessionFork(session.hostId),
          busy: threadActionBusy(session),
          onCompact: () => void compactSession(session),
          onCompactWithInstructions: () => {
            setCompactError('');
            setCompactTarget(session);
          },
          onRestart: () => {
            setRestartError('');
            setRestartTarget(session);
          },
        });
  const threadActions = (session: Session): RowAction[] => {
    if (!window.nesvo || managedSession(session)) return [];
    const conversation = sessionConversationActions(session).map(action => ({
      label: action.label,
      icon: action.icon,
      disabled: action.disabled,
      onSelect: action.run,
    }));
    return [
      ...(supportsSessionFork(session.hostId)
        ? [
            {
              label: 'Fork session',
              icon: <GitFork />,
              disabled:
                threadActionBusy(session) || !session.providerInitialized,
              onSelect: () => void chooseFork(session),
            },
          ]
        : []),
      ...conversation,
    ];
  };
  const terminalResumeOf = (session: Session) =>
    terminalResume(
      session.provider,
      session.providerSessionId,
      session.directory,
    );
  const canOpenInTerminal = (session: Session) =>
    !!window.nesvo &&
    session.role !== 'worker' &&
    !session.workflowStepId &&
    !session.externalAttachment &&
    !terminalPending &&
    store.hostReady(session.hostId) &&
    session.status !== 'running' &&
    session.status !== 'stopping' &&
    !!terminalResumeOf(session) &&
    !!store.computers
      .find(computer => computer.id === session.hostId)
      ?.capabilities.includes('terminal-handoff');
  const showSessionError = (session: Session, message: string) =>
    setErrors(previous => ({ ...previous, [entityKey(session)]: message }));
  const openInTerminal = async (session: Session) => {
    const resume = terminalResumeOf(session);
    if (!resume) return;
    if (session.hostId !== 'local') {
      setTerminalCommandError('');
      setTerminalCommand({ session, command: resume.commandLine });
      return;
    }
    const key = entityKey(session);
    setTerminalPending(key);
    showSessionError(session, '');
    try {
      const opened = await window.nesvo.openSessionInTerminal(
        { sessionId: session.id },
        session.hostId,
      );
      store.merge([opened.session]);
      setTerminalNames(previous => ({ ...previous, [key]: opened.terminal }));
    } catch (error) {
      showSessionError(
        session,
        `The terminal could not be opened. ${errorDetail(error)}`,
      );
    } finally {
      setTerminalPending('');
    }
  };
  const handOffToTerminal = async () => {
    if (!terminalCommand) return true;
    const { session, command } = terminalCommand;
    setTerminalCommandError('');
    try {
      await navigator.clipboard.writeText(command);
      store.merge([
        await desktopApi(session.hostId).setSessionTerminal({
          sessionId: session.id,
          attached: true,
        }),
      ]);
      return true;
    } catch (error) {
      setTerminalCommandError(errorDetail(error));
      return false;
    }
  };
  const returnFromTerminal = async (session: Session) => {
    const key = entityKey(session);
    setTerminalPending(key);
    showSessionError(session, '');
    try {
      store.merge([
        await desktopApi(session.hostId).setSessionTerminal({
          sessionId: session.id,
          attached: false,
        }),
      ]);
    } catch (error) {
      showSessionError(
        session,
        `The session could not return to Nesvo. ${errorDetail(error)}`,
      );
    } finally {
      setTerminalPending('');
    }
  };
  const terminalAction = (session: Session): RowAction[] =>
    !window.nesvo ||
    session.role === 'worker' ||
    session.workflowStepId ||
    !store.computers
      .find(computer => computer.id === session.hostId)
      ?.capabilities.includes('terminal-handoff')
      ? []
      : [
          {
            label:
              session.hostId === 'local'
                ? 'Open in terminal'
                : 'Open in terminal…',
            icon: <SquareTerminal />,
            disabled: !canOpenInTerminal(session),
            onSelect: () => void openInTerminal(session),
          },
        ];
  const creationGroupName = creationGroup
    ? store
        .groups(creationGroup.hostId)
        .find(group => group.id === creationGroup.groupId)?.name
    : undefined;
  const exportAction = (session: Session): RowAction => ({
    label: 'Export as Markdown…',
    icon: <FileDown />,
    disabled: !window.nesvo,
    onSelect: () =>
      void window.nesvo
        .saveTextFile({
          defaultName: sessionMarkdownFileName(session),
          content: sessionMarkdown(session),
        })
        .catch((error: unknown) =>
          setErrors(previous => ({
            ...previous,
            [entityKey(session)]:
              `The session could not be exported. ${errorDetail(error)}`,
          })),
        ),
  });
  const supportsDelete = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('session-delete');
  const deleteAction = (session: Session): RowAction | null =>
    window.nesvo &&
    supportsDelete(session.hostId) &&
    isGroupableSession(session) &&
    !session.workflowRunId
      ? {
          label: 'Delete…',
          icon: <Trash2 />,
          destructive: true,
          disabled:
            !store.hostReady(session.hostId) ||
            session.status === 'running' ||
            session.status === 'stopping',
          onSelect: () => setDeleteTarget(session),
        }
      : null;
  const headerThreadActions =
    !browsing && !creating && selected
      ? [
          ...threadActions(selected),
          ...terminalAction(selected),
          exportAction(selected),
        ]
      : [];
  const finishWorktreeAvailable =
    !browsing && !creating && !!selected?.worktree && !!window.nesvo;
  const headerOwnActions: RowAction[] = [
    ...headerThreadActions,
    ...(finishWorktreeAvailable
      ? [
          ...(headerThreadActions.length ? ['separator' as const] : []),
          {
            label: 'Finish worktree…',
            icon: <FolderCheck />,
            onSelect: () => setFinishingWorktree(true),
          },
        ]
      : []),
  ];
  const headerDelete =
    !browsing && !creating && selected ? deleteAction(selected) : null;
  const headerActions: RowAction[] = headerDelete
    ? [
        ...headerOwnActions,
        ...(headerOwnActions.length ? ['separator' as const] : []),
        headerDelete,
      ]
    : headerOwnActions;
  const showSession = (session: Session, then: () => void) => {
    const key = entityKey(session);
    if (key === selectedKey && !browsing && !creating) {
      then();
      return;
    }
    guardEditor(() => {
      selectNow(key);
      then();
    });
  };
  const openSessionFiles = (session: Session) =>
    showSession(session, () => {
      diffTrigger.current = panelTrigger();
      setCardOpen(false);
      const latest = store.reviews
        .filter(
          review =>
            review.sessionId === session.id && review.hostId === session.hostId,
        )
        .sort((a, b) => b.version - a.version)[0];
      setDiffTarget(latest ? { reviewId: latest.id } : null);
      setPanel('files');
    });
  const openSessionMcp = (session: Session) =>
    showSession(session, () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('[data-session-mcp]')?.click(),
        ),
      ),
    );
  const rowCommand = (id: string, action: RowAction): PaletteCommand[] =>
    action === 'separator'
      ? []
      : [
          {
            id,
            label: action.label,
            icon: action.icon,
            disabled: action.disabled,
            run: action.onSelect,
          },
        ];
  const sessionCommands = (session: Session): PaletteCommand[] => {
    const groupable = isGroupableSession(session);
    const archived = !!session.archivedAt;
    const ready = store.hostReady(session.hostId);
    const busy = session.status === 'running' || session.status === 'stopping';
    const housekept = groupable && housekeeping.supports(session.hostId);
    const removal = deleteAction(session);
    const commands: PaletteCommand[] = [
      {
        id: 'rename',
        label: 'Rename…',
        icon: <Pencil />,
        keywords: 'title name',
        disabled: !ready || !housekeeping.supports(session.hostId),
        run: () => setRenameTarget(session),
      },
    ];
    if (housekept && !archived)
      commands.push(
        {
          id: 'pin',
          label: session.pinned ? 'Unpin' : 'Pin',
          icon: session.pinned ? <PinOff /> : <Pin />,
          keywords: 'favorite top',
          disabled: !ready,
          run: () => void housekeeping.setPinned(session, !session.pinned),
        },
        {
          id: 'move',
          label: 'Move to group…',
          icon: <FolderInput />,
          keywords: 'group folder organize',
          disabled: !ready,
          run: () => setMoveTarget(session),
        },
      );
    threadActions(session).forEach((action, index) =>
      commands.push(...rowCommand(`thread-${index}`, action)),
    );
    commands.push(...rowCommand('export', exportAction(session)));
    if (session.worktree && window.nesvo)
      commands.push({
        id: 'finish-worktree',
        label: 'Finish worktree…',
        icon: <FolderCheck />,
        keywords: 'branch checkout keep remove',
        run: () => showSession(session, () => setFinishingWorktree(true)),
      });
    commands.push({
      id: 'files',
      label: 'Open files',
      icon: <FolderOpen />,
      shortcut: shortcutKeys('files'),
      keywords: 'explorer tree panel',
      run: () => openSessionFiles(session),
    });
    commands.push({
      id: 'details',
      label: 'Session details',
      icon: <Gauge />,
      keywords:
        'computer folder branch worktree workflow limits usage context window',
      run: () =>
        showSession(session, () =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => openCard(null)),
          ),
        ),
    });
    if (
      supportsMcp(session.hostId) &&
      session.role !== 'worker' &&
      !session.workflowRunId
    )
      commands.push({
        id: 'mcp',
        label: 'MCP servers…',
        icon: <Plug />,
        keywords: 'tools hooks servers',
        disabled: !ready,
        run: () => openSessionMcp(session),
      });
    if (housekept)
      commands.push({
        id: 'archive',
        label: archived ? 'Unarchive' : 'Archive',
        icon: archived ? <ArchiveRestore /> : <Archive />,
        keywords: 'hide restore',
        disabled: !ready || (!archived && busy),
        run: () => void housekeeping.setArchived(session, !archived),
      });
    if (removal) commands.push(...rowCommand('delete', removal));
    return commands.map(command => ({
      ...command,
      id: `session-${command.id}`,
    }));
  };
  const paletteSessionActions = (key: string) => {
    const session = store.sessions.find(item => entityKey(item) === key);
    return session ? sessionCommands(session) : [];
  };
  const forkSource = !browsing && !creating ? selected?.forkOf : null;
  const sidebarProps = {
    profilesFor,
    accountLabel,
    threadActions,
    deleteAction,
    housekeeping,
    loading: store.loading,
    currentHostId: creating ? threadSetup.hostId : selectedHostId,
    sessions: store.sessions,
    workflowRuns: store.workflowRuns,
    computers: store.computers,
    hostName: selectedComputer?.name ?? 'Local',
    onComputers: () => {
      setNavigationOpen(false);
      setSettingsPage('computers');
    },
    onSettings: () => {
      setNavigationOpen(false);
      setSettingsPage('general');
    },
    pendingActions:
      store.reviews.filter(review => review.status === 'pending').length +
      store.sessions.reduce(
        (count, session) =>
          count +
          (session.status === 'running' && session.runId
            ? session.pendingApprovals.length +
              session.delegations.filter(
                item =>
                  item.runId === session.runId && item.status === 'pending',
              ).length
            : 0),
        0,
      ),
    selectedId:
      creating || costsView || workflowsView || pullRequestsView || automation
        ? ''
        : selectedKey,
    unreadKeys,
    inbox,
    workflows: workflowsView,
    onSelect: select,
    onSearchHistory: openHistorySearch,
    onInbox: openInbox,
    onWorkflows: openWorkflows,
    onCreate: openCreate,
    scheduledJobs: automations.jobs,
    automations: !!automation,
    automationsAvailable: automationComputers.length > 0,
    onAutomations: () => openAutomations(),
    pullRequests: pullRequestsView,
    onPullRequests: pullRequestsAvailable ? openPullRequests : undefined,
    filter: sessionFilter,
    filterKeys,
    onFilterChange: setSessionFilter,
  };
  const sessionOrder = () => {
    const visible = sidebarSessionKeys();
    if (visible.length > 0) return visible;
    return store.sessions
      .filter(
        session =>
          !session.archivedAt &&
          !session.scheduledJobId &&
          (sessionFilter === 'all' ||
            filterKeys[sessionFilter].has(entityKey(session))),
      )
      .map(entityKey);
  };
  const goToSession = (key: string) => {
    const followFocus = isSidebarSessionFocused();
    select(key);
    if (followFocus)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => focusSidebarSession(key)),
      );
  };
  const stepSession = (direction: 1 | -1) => {
    const order = sessionOrder();
    const index = order.indexOf(selectedKey);
    const next =
      index === -1
        ? order[direction === 1 ? 0 : order.length - 1]
        : order[index + direction];
    if (next) goToSession(next);
  };
  const nextNeedsMe = () => {
    const needs = filterKeys['needs-me'];
    const visible = sidebarSessionKeys();
    const order = [
      ...visible,
      ...store.sessions.map(entityKey).filter(key => !visible.includes(key)),
    ].filter(key => needs.has(key));
    const next = order[(order.indexOf(selectedKey) + 1) % order.length];
    if (next && (next !== selectedKey || browsing || creating))
      goToSession(next);
  };
  const lastSession = () => {
    const key = lastSelection.current.previous;
    if (key && store.sessions.some(session => entityKey(session) === key))
      goToSession(key);
  };
  const isWide = () => window.matchMedia('(min-width: 768px)').matches;
  const jumpToSection = (index: number) => {
    const jump = () => {
      const target = sidebarSection(index);
      const key = target?.sessionKey;
      if (!key) {
        target?.heading?.focus();
        return;
      }
      select(key);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => focusSidebarSession(key)),
      );
    };
    if (readSidebarOpen() || !isWide()) {
      jump();
      return;
    }
    setSidebarOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(jump));
  };
  const sessionPanels = !browsing && !creating && !!selected;
  const openSkills = () => {
    diffTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCardOpen(false);
    setPanel('skills');
  };
  useWorkspaceShortcuts({
    openPalette,
    openHistorySearch: () => openHistorySearch(),
    toggleSidebar: () => {
      if (isWide()) toggleSidebar(!readSidebarOpen());
    },
    newSession: openCreate,
    openSettings: () => setSettingsPage('general'),
    openFiles: () => {
      if (sessionPanels) openFiles();
    },
    stepSession,
    nextNeedsMe,
    lastSession,
    jumpToSection,
    focusComposer: () => {
      const composer = document.getElementById('message-input');
      if (!composer) return false;
      composer.focus();
      return true;
    },
  });
  const paletteCommands = () => {
    const latestReview = selected
      ? store.reviews
          .filter(
            review =>
              review.sessionId === selected.id &&
              review.hostId === selectedHostId,
          )
          .sort((a, b) => b.version - a.version)[0]
      : undefined;
    return workspaceCommands({
      newSession: openCreate,
      inbox: openInbox,
      workflows: openWorkflows,
      automations:
        automationComputers.length > 0 ? () => openAutomations() : undefined,
      pullRequests: pullRequestsAvailable ? openPullRequests : undefined,
      costs: window.nesvo ? openCosts : undefined,
      settings: () => setSettingsPage('general'),
      shortcuts: () => setSettingsPage('shortcuts'),
      toggleSidebar: isWide() ? () => toggleSidebar(!sidebarOpen) : undefined,
      files: sessionPanels ? openFiles : undefined,
      diff:
        sessionPanels && latestReview
          ? () => openDiff(latestReview.id)
          : undefined,
      skills: sessionPanels ? openSkills : undefined,
      searchHistory: () => openHistorySearch(),
      openInTerminal:
        !browsing && !creating && selected && canOpenInTerminal(selected)
          ? () => void openInTerminal(selected)
          : undefined,
      nextNeedsMe,
      needsMeCount: filterKeys['needs-me'].size,
      lastSession,
      conversation:
        !sessionPanels && !browsing && !creating && selected
          ? sessionConversationActions(selected).map(action => ({
              id: action.id,
              label: action.label,
              icon: action.icon,
              keywords: `${action.keywords} current session`,
              disabled: action.disabled,
              run: action.run,
            }))
          : [],
    }).concat(
      sessionPanels && selected
        ? sessionCommands(selected)
            .filter(command => command.id !== 'session-files')
            .map(command => ({
              ...command,
              group: 'Current session',
              keywords: [command.keywords, 'session current'].join(' '),
            }))
        : [],
    );
  };
  const readBranch = window.nesvo
    ? (hostId: string, directory: string) =>
        desktopApi(hostId).readGitBranch({ directory })
    : undefined;
  const showingNewThread =
    creating || (!browsing && !selected && !store.loading && !store.error);
  const breadcrumbDirectory = showingNewThread
    ? threadSetup.directory.trim()
    : !browsing && selected
      ? (selected.worktree?.projectDirectory ?? selected.directory)
      : null;
  const breadcrumbHostId = showingNewThread
    ? threadSetup.hostId
    : selectedHostId;
  const branchReadable =
    !!window.nesvo &&
    store.hostReady(breadcrumbHostId) &&
    !!store.computers
      .find(computer => computer.id === breadcrumbHostId)
      ?.capabilities.includes('git-branch');
  const headerWorktree =
    !showingNewThread && !browsing ? selected?.worktree : undefined;
  const branch = useGitBranch({
    hostId: breadcrumbHostId,
    directory: breadcrumbDirectory ?? '',
    enabled: branchReadable && !headerWorktree,
    api: window.nesvo ? desktopApi(breadcrumbHostId) : undefined,
  });
  const sessionWorktree = selected?.worktree ?? parentSession?.worktree;
  const finishedWorktree =
    !!sessionWorktree && sessionWorktree.state !== 'active';
  const providerIssue =
    !browsing &&
    !creating &&
    selectedProviderState &&
    (selectedProviderState.error ||
      selectedProviderState.status?.status !== 'ready')
      ? selectedProviderState
      : null;
  return (
    <div className="relative flex h-dvh min-h-0 overflow-hidden bg-background">
      {palette && (
        <CommandPalette
          initialMode={palette.mode}
          returnFocus={palette.returnFocus}
          commands={paletteCommands()}
          sessions={paletteSessions(
            store.sessions,
            store.computers,
            store.groups,
            filterKeys,
          )}
          sessionActions={paletteSessionActions}
          onOpenSession={goToSession}
          onClose={() => setPalette(null)}
        />
      )}
      {forkTarget && (
        <ForkWorktreeDialog
          key={entityKey(forkTarget)}
          title={forkTarget.title}
          onFork={worktree => forkSession(forkTarget, worktree)}
          onClose={() => setForkTarget(null)}
        />
      )}
      <ConfirmDialog
        open={!!restartTarget}
        onOpenChange={open => {
          if (!open) setRestartTarget(null);
        }}
        title="Restart session?"
        description={`Your next message in “${restartTarget?.title ?? ''}” starts a fresh ${restartTarget?.provider ?? 'provider'} conversation without the earlier context. The history, folder and permission mode stay in this session.`}
        confirmLabel="Restart session"
        pendingLabel="Restarting…"
        tone="default"
        onConfirm={() => (restartTarget ? restartSession(restartTarget) : true)}
      >
        {restartError && (
          <StatusMessage tone="error">{restartError}</StatusMessage>
        )}
      </ConfirmDialog>
      <TerminalCommandDialog
        open={!!terminalCommand}
        onOpenChange={open => {
          if (!open) setTerminalCommand(null);
        }}
        computerName={
          store.computers.find(
            computer => computer.id === terminalCommand?.session.hostId,
          )?.name ?? 'that computer'
        }
        command={terminalCommand?.command ?? ''}
        error={terminalCommandError}
        onConfirm={handOffToTerminal}
      />
      <RenameSessionDialog
        session={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRename={housekeeping.renameSession}
      />
      <MoveToGroupDialog
        key={moveTarget ? entityKey(moveTarget) : 'closed'}
        open={!!moveTarget}
        onOpenChange={open => {
          if (!open) setMoveTarget(null);
        }}
        title={`Move “${moveTarget?.title ?? ''}” to`}
        groups={moveTarget ? store.groups(moveTarget.hostId) : []}
        currentId={moveTarget?.groupId ?? null}
        rootLabel="Ungrouped"
        isAllowed={() => true}
        onMove={groupId => {
          if (moveTarget) void housekeeping.moveSession(moveTarget, groupId, 0);
        }}
        onCreate={name => {
          const target = moveTarget;
          if (!target) return;
          void housekeeping
            .createGroup(target.hostId, null, name)
            .then(groupId => {
              if (groupId) void housekeeping.moveSession(target, groupId, 0);
            });
        }}
      />
      {window.nesvo && (
        <SessionDeletion
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          api={desktopApi}
          onDeleted={deletion =>
            store.remove(deletion.hostId, deletion.sessionIds)
          }
          onRestored={session => store.merge([session])}
        />
      )}
      {compactTarget && (
        <CompactInstructionsDialog
          key={entityKey(compactTarget)}
          title={compactTarget.title}
          error={compactError}
          onCompact={instructions =>
            compactSession(compactTarget, instructions)
          }
          onClose={() => setCompactTarget(null)}
        />
      )}
      {historySearch && (
        <HistorySearchDialog
          computers={store.computers}
          initialQuery={historySearch.query}
          returnFocus={historySearch.returnFocus}
          onClose={() => setHistorySearch(null)}
          onOpenResult={(hostId, result) => {
            setHistorySearch(null);
            guardEditor(() => {
              selectNow(hostKey(result.sessionId, hostId));
              if (result.messageId) setMessageTarget({ id: result.messageId });
            });
          }}
          onOpenTranscript={(hostId, { provider, providerSessionId }) => {
            setHistorySearch(null);
            setTranscriptImport({
              hostId,
              conversation: { provider, providerSessionId },
            });
          }}
        />
      )}
      {transcriptImport && (
        <ImportConversation
          key={[
            transcriptImport.hostId,
            transcriptImport.conversation.provider,
            transcriptImport.conversation.providerSessionId,
          ].join(':')}
          open
          onOpenChange={open => {
            if (!open) setTranscriptImport(null);
          }}
          computer={store.computers.find(
            computer => computer.id === transcriptImport.hostId,
          )}
          profiles={profilesFor(transcriptImport.hostId)}
          api={desktopApi(transcriptImport.hostId)}
          initialSelection={transcriptImport.conversation}
          onAdopted={session => {
            store.merge([session]);
            guardEditor(() => select(entityKey(session)));
          }}
        />
      )}
      <div className="hidden h-full shrink-0 md:flex">
        <NavigationRail
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => toggleSidebar(!sidebarOpen)}
          sidebarToggleRef={sidebarToggle}
          pendingActions={sidebarProps.pendingActions}
          inbox={sidebarProps.inbox}
          workflows={sidebarProps.workflows}
          automations={sidebarProps.automations}
          automationsAvailable={sidebarProps.automationsAvailable}
          hostName={sidebarProps.hostName}
          onCreate={sidebarProps.onCreate}
          onInbox={sidebarProps.onInbox}
          onWorkflows={sidebarProps.onWorkflows}
          onAutomations={sidebarProps.onAutomations}
          pullRequests={sidebarProps.pullRequests}
          onPullRequests={sidebarProps.onPullRequests}
          costs={costsView}
          onCosts={window.nesvo ? openCosts : undefined}
          onSettings={sidebarProps.onSettings}
          onComputers={sidebarProps.onComputers}
          usage={
            <ProviderUsage
              key={`${selectedHostId}/rail`}
              layout="column"
              popoverSide="top"
              {...usageProps}
            />
          }
        />
      </div>
      <aside
        aria-label="Sidebar"
        data-state={sidebarOpen ? 'expanded' : 'collapsed'}
        style={{ width: visibleSidebarWidth }}
        className={cn(
          'relative hidden shrink-0 border-r border-sidebar-border bg-sidebar',
          sidebarOpen && 'md:block',
        )}
      >
        {sidebarOpen && (
          <>
            <div className="h-full overflow-hidden">
              <SessionSidebar
                {...sidebarProps}
                navigation="rail"
                readBranch={readBranch}
              />
            </div>
            <SidebarResizer
              width={visibleSidebarWidth}
              onResize={width =>
                setSidebarWidth(clampSidebarWidth(width, viewportWidth))
              }
            />
          </>
        )}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header
          className={cn(
            'drag-region flex h-(--shell-topbar-height) shrink-0 items-center gap-1.5 pr-[calc(var(--shell-gutter)+var(--titlebar-inset-right))] pl-[calc(0.5rem+var(--titlebar-inset-left))]',
            sidebarOpen && 'md:pl-2',
            visiblePanel && 'min-[1200px]:pr-(--shell-gutter)',
          )}
        >
          <div className="md:hidden">
            <ProviderUsage
              key={`${selectedHostId}/compact`}
              layout="account"
              popoverSide="bottom"
              {...usageProps}
            />
          </div>
          <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
            <SheetTrigger asChild>
              <IconButton
                ref={navigationToggle}
                size={32}
                className="md:hidden"
                label="Open sessions"
              >
                <Menu />
              </IconButton>
            </SheetTrigger>
            <SheetContent side="left" className="w-72">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>Sessions and inbox.</SheetDescription>
              </SheetHeader>
              <SessionSidebar {...sidebarProps} />
            </SheetContent>
          </Sheet>
          {!sidebarOpen && (
            <BrandWordmark className="hidden pr-2 select-none md:block" />
          )}
          {parentSession && !browsing && !creating && (
            <IconButton
              size={32}
              label="Back to parent session"
              onClick={() => select(entityKey(parentSession))}
            >
              <ArrowLeft />
            </IconButton>
          )}
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1 px-1">
            <ol className="flex min-w-0 items-center gap-2 text-ui">
              {breadcrumbDirectory !== null && (
                <>
                  <li className="hidden min-w-0 max-w-[min(20rem,50%)] shrink-0 items-center gap-1.5 text-muted-foreground sm:flex">
                    {breadcrumbDirectory ? (
                      <ProjectChip
                        label={directoryLabel(breadcrumbDirectory)}
                      />
                    ) : (
                      <SquareDashed
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">
                      {breadcrumbDirectory
                        ? directoryLabel(breadcrumbDirectory)
                        : 'No project'}
                    </span>
                    <BranchChip branch={branch} worktree={headerWorktree} />
                  </li>
                  <li
                    aria-hidden="true"
                    className="hidden text-muted-foreground/60 sm:block"
                  >
                    /
                  </li>
                </>
              )}
              {automationView === 'detail' && (
                <>
                  <li className="shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      className="font-normal text-muted-foreground"
                      onClick={() => openAutomations()}
                    >
                      Automations
                    </Button>
                  </li>
                  <li aria-hidden="true" className="text-muted-foreground/60">
                    /
                  </li>
                </>
              )}
              <li
                aria-current="page"
                className="flex min-w-0 items-center gap-3"
              >
                <h1 className="truncate text-ui font-semibold">
                  {costsView
                    ? 'Costs'
                    : creating
                      ? creationGroupName
                        ? `New thread · ${creationGroupName}`
                        : 'New thread'
                      : workflowsView
                        ? workflowsEditor
                          ? `Graph editor · ${workflowsEditor.workflowName ?? 'New workflow'}`
                          : 'Workflows'
                        : pullRequestsView
                          ? 'Pull requests'
                          : inbox
                            ? 'Inbox'
                            : automationView === 'detail'
                              ? automationJob?.name
                              : automationView === 'list'
                                ? 'Automations'
                                : (selected?.title ?? 'New thread')}
                </h1>
                {selected && forkSource && (
                  <Button
                    asChild
                    variant="link"
                    size="inline"
                    className="min-w-0 text-2xs text-muted-foreground"
                  >
                    <a
                      href={
                        forkSource.messageId
                          ? `#message-${forkSource.messageId}`
                          : '#'
                      }
                      onClick={event => {
                        event.preventDefault();
                        selectNow(
                          hostKey(forkSource.sessionId, selected.hostId),
                        );
                        if (forkSource.messageId)
                          setMessageTarget({ id: forkSource.messageId });
                      }}
                    >
                      <span className="truncate">
                        Forked from {forkSource.title}
                      </span>
                    </a>
                  </Button>
                )}
                {!browsing &&
                  !creating &&
                  selected &&
                  sessionRoleLabel(selected) && (
                    <span className="hidden text-2xs text-muted-foreground sm:inline">
                      {sessionRoleLabel(selected)}
                    </span>
                  )}
                {!browsing && !creating && selected && window.nesvo && (
                  <SessionPullRequest
                    key={selectedKey}
                    session={selected}
                    unavailableReason={pullRequestBlockedReason(
                      selected.hostId,
                    )}
                    api={desktopApi(selected.hostId)}
                    onOpen={reference =>
                      openPullRequest({ hostId: selected.hostId, reference })
                    }
                    onLinked={session => store.merge([session])}
                  />
                )}
              </li>
            </ol>
          </nav>
          {!browsing && !creating && selectedAccount && (
            <Hint label={`Account: ${selectedAccount}`}>
              <Chip size="sm" interactive={false} className="max-w-28">
                <span className="truncate">{selectedAccount}</span>
              </Chip>
            </Hint>
          )}
          {!browsing && !creating && selected && (
            <span className="max-w-32 truncate text-2xs text-muted-foreground">
              {selectedHostId !== 'local'
                ? (selectedComputer?.name ?? 'Remote')
                : ''}
              {!store.hostReady(selectedHostId) ? ' · Offline' : ''}
            </span>
          )}
          {!browsing &&
            !creating &&
            selected &&
            selected.status !== 'ready' &&
            !showsRunStatus(selected, selectedRun) && (
              <span className="hidden shrink-0 text-2xs text-muted-foreground sm:inline">
                {sessionStatusLabel(selected)}
              </span>
            )}
          {finishingWorktree && headerWorktree && selected && window.nesvo && (
            <FinishWorktreeDialog
              key={selectedKey}
              sessionId={selected.id}
              worktree={headerWorktree}
              setupAvailable={
                store.hostReady(selectedHostId) &&
                !!selectedComputer?.capabilities.includes(
                  'session-worktree-tools',
                )
              }
              api={desktopApi(selectedHostId)}
              blockedReason={
                !store.hostReady(selectedHostId)
                  ? 'Connect this computer to finish the worktree.'
                  : !selectedComputer?.capabilities.includes(
                        'session-worktrees',
                      )
                    ? 'Update the host and reconnect to finish the worktree.'
                    : activeRun || sending
                      ? 'Wait for active work on this computer to finish.'
                      : ''
              }
              onFinished={(session, choice) => {
                store.merge([session]);
                if (choice === 'pull-request') openPullRequestsNow(session);
              }}
              onClose={() => setFinishingWorktree(false)}
            />
          )}
          <IconButton
            size={32}
            className="md:hidden"
            label="New session"
            shortcut={shortcutKeys('newSession')}
            onClick={openCreate}
          >
            <Plus />
          </IconButton>
          {headerActions.length > 0 && (
            <RowActionsMenu
              header
              label="Session actions"
              actions={headerActions}
            />
          )}
          {cardRun ? (
            <WorkflowStatus
              run={cardRun}
              open={cardOpen}
              onToggle={toggleCard}
            />
          ) : (
            <IconButton
              size={32}
              label="Session details"
              pressed={cardOpen}
              aria-controls={cardOpen ? 'session-card' : undefined}
              data-session-card-trigger
              onClick={event => toggleCard(event.currentTarget)}
            >
              <Gauge />
            </IconButton>
          )}
          {!browsing && !creating && selected && (
            <IconButton
              size={32}
              label="Open skills"
              pressed={panel === 'skills'}
              onClick={openSkills}
            >
              <BookOpen />
            </IconButton>
          )}
          {!browsing && !creating && selected && (
            <IconButton
              size={32}
              label="Open files"
              shortcut={shortcutKeys('files')}
              pressed={panel === 'files'}
              onClick={openFiles}
            >
              <FolderOpen />
            </IconButton>
          )}
          {!browsing && !creating && selected && (
            <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
              <SheetTrigger asChild>
                <IconButton size={32} label="Open context">
                  <PanelRight />
                </IconButton>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Context</SheetTitle>
                  <SheetDescription>
                    Session details and access.
                  </SheetDescription>
                </SheetHeader>
                <ScrollArea className="min-h-0 flex-1">
                  <SessionDetails session={selected} />
                </ScrollArea>
              </SheetContent>
            </Sheet>
          )}
        </header>
        {store.error && (
          <div className="flex max-h-32 shrink-0 flex-wrap items-center gap-3 overflow-y-auto border-b px-5 py-2.5">
            <StatusMessage tone="error">{store.error}</StatusMessage>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload window
            </Button>
          </div>
        )}
        {providerIssue && selected && (
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-2">
            <StatusMessage tone={providerIssue.error ? 'error' : 'warning'}>
              {providerIssue.error ||
                providerStatusLabel(selected.provider, providerIssue)}
            </StatusMessage>
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setSettingsPage('general')}
            >
              View status
            </Button>
          </div>
        )}
        <main className="relative flex min-h-0 min-w-0 flex-1">
          {cardOpen && (
            <SessionCard
              id="session-card"
              computer={selectedComputer}
              connection={connection}
              session={cardSession}
              run={cardRun}
              gitBranch={branch}
              onComputers={() => setSettingsPage('computers')}
              onFiles={openFiles}
              onRunWorkflow={() =>
                cardSession && void runAssignedWorkflow(cardSession)
              }
              onClose={closeCard}
              workflow={
                cardRun && (
                  <WorkflowSection
                    key={entityKey(cardRun)}
                    run={cardRun}
                    steps={selectedRunSteps}
                    connected={store.hostReady(selectedHostId)}
                    pending={!!workflowPending[entityKey(cardRun)]}
                    error={workflowErrors[entityKey(cardRun)] ?? ''}
                    api={window.nesvo.workflows}
                    onStop={() => void controlWorkflow('stop')}
                    onResume={() => void controlWorkflow('resume')}
                    onConfirmAction={stepId =>
                      void controlWorkflow('confirm', stepId)
                    }
                    onInbox={openInbox}
                    onSession={select}
                  />
                )
              }
              workers={
                cardSession && (
                  <WorkersSection workers={workers} onSession={select} />
                )
              }
              usage={
                <UsageSection
                  states={usage.states}
                  connected={store.hostReady(selectedHostId)}
                />
              }
              context={
                cardSession && (
                  <ContextSection
                    context={cardSession.context}
                    provider={cardSession.provider}
                  />
                )
              }
            />
          )}
          {showingNewThread ? (
            <NewThread
              setup={threadSetup}
              onSetupChange={setThreadSetup}
              computers={store.computers}
              statuses={store.providerStates(threadSetup.hostId)}
              profiles={profilesFor(threadSetup.hostId)}
              onRefreshProvider={provider =>
                void store.refreshProvider(provider, threadSetup.hostId)
              }
              onManageComputers={() => setSettingsPage('computers')}
              busyReason={threadBusyReason}
              gitRepository={!!branch && branch.kind !== 'none'}
              hostApi={desktopApi(threadSetup.hostId)}
              onAdopted={session => {
                store.merge([session]);
                setCreationGroup(null);
                select(entityKey(session));
              }}
              onStart={startThread}
              onStartWorkflow={startWorkflowTask}
            />
          ) : workflowsView && workflowsEditor ? (
            <Suspense
              fallback={
                <StatusMessage tone="loading" className="p-6">
                  Loading the graph editor…
                </StatusMessage>
              }
            >
              <WorkflowGraphEditor
                key={`${workflowsEditor.hostId}:${workflowsEditor.directory}:${workflowsEditor.workflowName ?? ''}`}
                hostId={workflowsEditor.hostId}
                directory={workflowsEditor.directory}
                workflowName={workflowsEditor.workflowName}
                catalog={workflowsEditor.catalog}
                draft={workflowsEditor.draft}
                api={window.nesvo.workflows}
                scheduledJobsApi={window.nesvo.scheduledJobs}
                computers={store.computers}
                statuses={store.providerStates(workflowsEditor.hostId)}
                onClose={() => setWorkflowsEditor(null)}
                onDirtyChange={setEditorDirty}
                onDiscoverSkills={discoverEditorSkills}
                onRefreshProvider={provider =>
                  void store.refreshProvider(provider, workflowsEditor.hostId)
                }
                onRun={async input => {
                  const run = await window.nesvo.workflows.startTask(
                    workflowsEditor.hostId,
                    input,
                  );
                  store.mergeWorkflowRuns([run]);
                }}
                runOverlay={editorRunOverlay}
                onInbox={openInbox}
                onSession={select}
                assistantAdded={editorAssistantAdded}
                dock={context => (
                  <Suspense fallback={null}>
                    <WorkflowAssistantDock
                      hostId={workflowsEditor.hostId}
                      directory={workflowsEditor.directory}
                      context={{
                        view: 'editor',
                        workflowName: context.workflowName,
                        document: context.document,
                        selection: context.selection,
                      }}
                      statuses={store.providerStates(workflowsEditor.hostId)}
                      computers={store.computers}
                      sessions={store.sessions}
                      proposals={store.assistantProposals}
                      changes={assistantChangesFor(workflowsEditor.hostId)}
                      refusals={assistantRefusalsFor(workflowsEditor.hostId)}
                      onRefreshProvider={provider =>
                        void store.refreshProvider(
                          provider,
                          workflowsEditor.hostId,
                        )
                      }
                      onApplied={() => {
                        context.onApplied();
                        void automations.reload(workflowsEditor.hostId);
                      }}
                      onLoadSession={openSession}
                      onOpenSession={sessionId =>
                        select(hostKey(sessionId, workflowsEditor.hostId))
                      }
                      onStop={sessionId =>
                        stopAssistantSession(workflowsEditor.hostId, sessionId)
                      }
                      onUndo={async change => {
                        const result = await undoAssistantChange(
                          workflowsEditor.hostId,
                          change,
                        );
                        if (result.status === 'undone') context.onApplied();
                        return result;
                      }}
                      canOpenChange={canOpenAssistantChange(true)}
                      onLoadChanges={conversationId =>
                        loadAssistantChanges(
                          workflowsEditor.hostId,
                          conversationId,
                        )
                      }
                      onOpenChange={change => {
                        if (
                          change.kind === 'step' &&
                          change.target.type === 'definition'
                        )
                          context.onFocusStep(change.target.name);
                        else
                          openAssistantChange(workflowsEditor.hostId, change);
                      }}
                    />
                  </Suspense>
                )}
              />
            </Suspense>
          ) : workflowsView ? (
            <Suspense
              fallback={
                <StatusMessage tone="loading" className="p-6">
                  Loading workflows…
                </StatusMessage>
              }
            >
              <div className="relative flex min-h-0 min-w-0 flex-1">
                <WorkflowDefinitions
                  computers={store.computers}
                  hostId={workflowsSource.hostId}
                  directory={workflowsSource.directory}
                  api={window.nesvo.workflows}
                  refreshToken={definitionsRefresh}
                  highlighted={listAssistantAdded}
                  onSourceChange={setWorkflowsSource}
                  onEdit={target => {
                    setWorkflowsSource({
                      hostId: target.hostId,
                      directory: target.directory,
                    });
                    setWorkflowsEditor(target);
                  }}
                  onCreate={setNewWorkflow}
                />
                {assistantDock(
                  workflowsSource.hostId,
                  workflowsSource.directory,
                  {
                    view: 'workflows',
                    workflowName: null,
                    document: null,
                    selection: [],
                  },
                  () => refreshAfterAssistant(workflowsSource.hostId),
                )}
              </div>
            </Suspense>
          ) : pullRequestsView ? (
            <div
              className={cn(
                'flex min-h-0 min-w-0 flex-1',
                panel === 'pull-request' &&
                  pullRequestTarget &&
                  'max-[1200px]:hidden',
              )}
            >
              <PullRequestsView
                key={
                  pullRequestHandoff
                    ? entityKey(pullRequestHandoff)
                    : 'pull-requests'
                }
                computers={store.computers}
                hostId={
                  pullRequestHandoff?.hostId ?? selected?.hostId ?? 'local'
                }
                directory={
                  pullRequestHandoff?.worktree?.projectDirectory ??
                  selected?.directory ??
                  ''
                }
                initialQuery={
                  pullRequestHandoff?.worktree
                    ? `head:${pullRequestHandoff.worktree.branch}`
                    : undefined
                }
                apiFor={pullRequestApi}
                openTarget={panel === 'pull-request' ? pullRequestTarget : null}
                onOpen={openPullRequest}
              />
            </div>
          ) : costsView ? (
            <CostsView
              api={window.nesvo}
              computers={store.computers}
              sessions={store.sessions}
              initialHostId={selectedHostId}
              onSession={select}
            />
          ) : inbox ? (
            <ReviewInbox
              {...reviewDecisionProps}
              reviews={store.reviews}
              automations={automations.jobs}
              automationPending={automationPending}
              automationErrors={automationErrors}
              onAutomation={job => openAutomations(entityKey(job))}
              onAutomationDecision={(job, decision) =>
                void decideAutomationStart(job, decision)
              }
              sessions={store.sessions}
              loading={store.reviewsLoading}
              error={store.reviewsError}
              operationEnabled={!store.loading && !store.error}
              computers={store.computers}
              isOperationEnabled={session => store.hostReady(session.hostId)}
              operationErrors={errors}
              approvalPending={approvalPending}
              delegationPending={delegationPending}
              onApproval={(input, hostId) =>
                void respondApproval(input, hostId)
              }
              onDelegation={(input, hostId) =>
                void decideDelegation(input, hostId)
              }
              onSession={select}
              onRefresh={store.reload}
              originLabel={review => {
                const session = store.sessions.find(
                  item =>
                    item.id === review.sessionId &&
                    item.hostId === review.hostId,
                );
                const name = session && jobOf(session)?.name;
                return session && isAutomationSession(session)
                  ? name
                    ? `Automation · ${name}`
                    : 'Automation'
                  : '';
              }}
              notice={runningAutomations.map(session => (
                <div key={entityKey(session)} className="mb-3 space-y-1 px-2">
                  <StatusMessage>{automationBusy(session)}</StatusMessage>
                  {automationErrors[automationErrorKey(session)] && (
                    <StatusMessage tone="error">
                      {automationErrors[automationErrorKey(session)]}
                    </StatusMessage>
                  )}
                </div>
              ))}
            />
          ) : automationView === 'detail' && automationJob ? (
            <AutomationDetail
              key={automation}
              job={automationJob}
              computer={store.computers.find(
                computer => computer.id === automationJob.hostId,
              )}
              runs={automations.runs(automationJob).runs}
              runsLoading={automations.runs(automationJob).loading}
              runsError={automations.runs(automationJob).error}
              hasMoreRuns={!!automations.runs(automationJob).nextCursor}
              reviews={store.reviews}
              pending={!!automationPending[automation]}
              error={automationErrors[automation] ?? ''}
              runBlockedReason={runBlockedReason(automationJob)}
              editBlockedReason={hostOffline(automationJob.hostId)}
              onRunNow={() => void runAutomationNow(automationJob)}
              onInbox={openInbox}
              onSetActive={active =>
                void setAutomationActive(automationJob, active)
              }
              onEdit={() =>
                openAutomationEditor(
                  automationValues(automationJob),
                  entityKey(automationJob),
                )
              }
              onDuplicate={() =>
                openAutomationEditor(duplicateValues(automationJob))
              }
              onDelete={() => deleteAutomation(automationJob)}
              onStop={run => void stopAutomationRun(automationJob, run)}
              onSession={select}
              onLoadMore={() =>
                void automations.loadRuns(
                  automationJob,
                  automations.runs(automationJob).nextCursor,
                )
              }
              onRetryRuns={() => void automations.loadRuns(automationJob)}
            />
          ) : automationView === 'list' ? (
            <div className="relative flex min-h-0 min-w-0 flex-1">
              <AutomationList
                jobs={automations.jobs}
                computers={store.computers}
                latestRun={latestRun}
                loading={automations.loading}
                notices={automationNotices}
                pending={automationPending}
                errors={automationErrors}
                createBlockedReason={
                  automationComputers.some(computer =>
                    store.hostReady(computer.id),
                  )
                    ? ''
                    : 'Connect a computer that supports automations.'
                }
                runBlockedReason={runBlockedReason}
                onCreate={createAutomation}
                onOpen={job => openAutomations(entityKey(job))}
                onRunNow={job => void runAutomationNow(job)}
                onSetActive={(job, active) =>
                  void setAutomationActive(job, active)
                }
                highlighted={assistantAddedAutomations(workflowsSource.hostId)}
              />
              {assistantDock(
                workflowsSource.hostId,
                workflowsSource.directory,
                {
                  view: 'automations',
                  workflowName: null,
                  document: null,
                  selection: [],
                },
                () => refreshAfterAssistant(workflowsSource.hostId),
              )}
            </div>
          ) : selected ? (
            <div
              className={cn(
                'flex min-h-0 min-w-0 flex-1',
                visiblePanel && 'max-[1200px]:hidden',
              )}
            >
              <Conversation
                key={selectedKey}
                session={selected}
                activity={(runId, startedAt, completedAt, status, live) => (
                  <SessionActivity
                    runId={runId}
                    items={selected.activities.filter(
                      item => item.runId === runId,
                    )}
                    startedAt={startedAt}
                    completedAt={completedAt}
                    status={status}
                    live={live && store.hostReady(selectedHostId)}
                    offline={live && !store.hostReady(selectedHostId)}
                    truncated={selected.activityTruncatedRunIds.includes(runId)}
                  />
                )}
                focusTarget={sessionTarget}
                messageTarget={messageTarget}
                workers={workers}
                results={
                  <SessionReviews
                    {...reviewDecisionProps}
                    reviews={store.reviews.filter(
                      review =>
                        review.sessionId === selected.id &&
                        review.hostId === selectedHostId,
                    )}
                    allReviews={store.reviews.filter(
                      review => review.hostId === selectedHostId,
                    )}
                    focusedId={
                      sessionTarget.startsWith('review-')
                        ? sessionTarget.slice(7)
                        : ''
                    }
                    onSession={select}
                    onOpenDiff={openDiff}
                  />
                }
                delegations={
                  <Delegations
                    session={selected}
                    children={workers}
                    enabled={operationEnabled}
                    pending={delegationPending}
                    onDecision={(delegationId, decision) =>
                      selected.runId &&
                      void decideDelegation(
                        {
                          sessionId: selected.id,
                          runId: selected.runId,
                          delegationId,
                          decision,
                        },
                        selectedHostId,
                      )
                    }
                    onPlanDecision={(delegationId, decision, correction) =>
                      selected.runId &&
                      void decideWorkerPlan(
                        {
                          sessionId: selected.id,
                          runId: selected.runId,
                          delegationId,
                          decision,
                          ...(correction ? { correction } : {}),
                        },
                        selectedHostId,
                      )
                    }
                    onSelect={select}
                  />
                }
                draft={drafts[selectedKey] ?? ''}
                selectedSkill={selectedSkills[selectedKey] ?? null}
                skillApi={desktopApi(selectedHostId)}
                connected={store.hostReady(selectedHostId)}
                onSkillChange={skill => changeSkill(selectedKey, skill)}
                sending={sending}
                finishedWorktree={finishedWorktree}
                handoff={
                  selected.externalAttachment ? (
                    <TerminalHandoffNotice
                      provider={selected.provider}
                      attachedAt={selected.externalAttachment.attachedAt}
                      terminal={terminalNames[selectedKey] ?? null}
                      pending={terminalPending === selectedKey}
                      disabled={!store.hostReady(selectedHostId)}
                      onReturn={() => void returnFromTerminal(selected)}
                    />
                  ) : undefined
                }
                canSend={
                  !sending &&
                  !finishedWorktree &&
                  !activeRun &&
                  connection === 'ready' &&
                  selectedProviderState?.status?.status === 'ready' &&
                  !selectedProviderState.loading &&
                  !selectedProviderState.error
                }
                approvalsEnabled={operationEnabled}
                approvalPending={approvalPending}
                onApproval={(requestId, decision, message) =>
                  selected.runId &&
                  void respondApproval(
                    {
                      sessionId: selected.id,
                      runId: selected.runId,
                      requestId,
                      decision,
                      ...(message ? { message } : {}),
                    },
                    selectedHostId,
                  )
                }
                otherRunLabel={
                  activeRun && isAutomationSession(activeRun)
                    ? automationBusy(activeRun, selectedKey)
                    : undefined
                }
                otherRun={
                  !!activeRun &&
                  activeRun.id !== selected.id &&
                  selected.status !== 'running' &&
                  selected.status !== 'stopping'
                }
                error={errors[selectedKey] ?? ''}
                onDraft={value => changeDraft(selectedKey, value)}
                onSend={typed => void send(typed)}
                onStop={() => void stop()}
                canQueue={
                  !sending &&
                  !finishedWorktree &&
                  connection === 'ready' &&
                  !selected.workflowStepId
                }
                onQueuedCancel={messageId =>
                  void changeQueued(selected, messageId, 'cancel')
                }
                onQueuedStart={messageId =>
                  void changeQueued(selected, messageId, 'start')
                }
                onQueuedEdit={(messageId, text) =>
                  void editQueued(selected, messageId, text)
                }
                onResend={() => void resend()}
                statuses={sessionStatuses}
                onRefreshProvider={provider => {
                  if (selected.profileId && selected.provider === provider)
                    selectedProfileStatus.refresh();
                  else void store.refreshProvider(provider, selectedHostId);
                }}
                pendingSelection={modelSelections[selectedKey] ?? null}
                onSelectModel={selection =>
                  setModelSelections(previous => ({
                    ...previous,
                    [selectedKey]: selection,
                  }))
                }
                modes={providerModes(
                  selected.provider,
                  selectedProviderState?.status,
                )}
                pendingMode={pendingModeOf(selected)}
                onSelectMode={mode =>
                  setModeSelections(previous => ({
                    ...previous,
                    [selectedKey]: mode,
                  }))
                }
                canChangeMode={supportsModes(selectedHostId)}
                attachments={{
                  items: composerAttachments.items(selectedKey),
                  notice: composerAttachments.notice(selectedKey),
                  support: imageSupport({
                    provider: selected.provider,
                    model:
                      modelSelections[selectedKey]?.model ?? selected.model,
                    modelLabel:
                      selectedProviderState?.status?.models.find(
                        option =>
                          option.id ===
                          (modelSelections[selectedKey]?.model ??
                            selected.model),
                      )?.label ?? 'This model',
                    state: selectedProviderState,
                    capabilities: selectedComputer?.capabilities ?? [],
                  }),
                  api: desktopApi(selectedHostId),
                  onAdd: (files, offset) =>
                    composerAttachments.add(
                      selectedKey,
                      desktopApi(selectedHostId),
                      files,
                      offset,
                    ),
                  onPlace: placement =>
                    composerAttachments.place(selectedKey, placement),
                  onRemove: localId =>
                    composerAttachments.remove(selectedKey, localId),
                  onNotice: notice =>
                    composerAttachments.notify(selectedKey, notice),
                }}
                workflowChip={
                  <SessionWorkflowChip
                    hostId={selected.hostId}
                    directory={selected.directory}
                    provider={selected.provider}
                    assigned={selected.workflow}
                    disabled={
                      connection !== 'ready' ||
                      selected.status === 'running' ||
                      selected.status === 'stopping' ||
                      selected.role === 'worker'
                    }
                    unsupported={!supportsSessionWorkflow(selectedHostId)}
                    onAssign={workflow =>
                      void assignWorkflow(selected, workflow)
                    }
                    onOpenEditor={name =>
                      openWorkflowEditor(
                        selected.hostId,
                        selected.directory,
                        name,
                      )
                    }
                  />
                }
                onLoadEarlier={() => loadEarlier(selectedKey)}
                contextMeter={
                  <ContextMeter
                    context={selected.context}
                    provider={selected.provider}
                    compact={sessionConversationActions(selected).find(
                      action => action.id === 'compact',
                    )}
                  />
                }
                mcpChip={
                  <McpChip
                    hostId={selected.hostId}
                    provider={selected.provider}
                    target={{ sessionId: selected.id }}
                    selection={{
                      servers: selected.mcp.servers.map(server => server.key),
                      hooks: selected.mcp.hooks,
                    }}
                    readOnly={
                      (pendingModeOf(selected) ?? selected.mode) === 'read-only'
                    }
                    disabled={connection !== 'ready'}
                    unsupported={!supportsMcp(selectedHostId)}
                    lockedReason={
                      selected.role === 'worker'
                        ? 'Set by the parent decision'
                        : selected.workflowRunId
                          ? 'Set when the workflow task started'
                          : ''
                    }
                    onChange={selection => void changeMcp(selected, selection)}
                  />
                }
              />
            </div>
          ) : (
            <section
              className="flex flex-1 items-center justify-center"
              aria-label="Sessions"
            >
              <EmptyState
                icon={History}
                title={
                  store.loading ? 'Loading sessions…' : 'History is unavailable'
                }
                description={
                  store.loading
                    ? 'Loading your local history.'
                    : 'Reconnect to load your saved sessions.'
                }
              />
            </section>
          )}
        </main>
      </div>
      {(panel === 'files' || panel === 'skills') &&
        !browsing &&
        !creating &&
        selected &&
        !store.hostReady(selectedHostId) && (
          <PanelPlaceholder
            kind={panel === 'files' ? 'files-tree' : 'skills'}
            icon={panel === 'files' ? FolderOpen : BookOpen}
            title={panel === 'files' ? 'Files' : 'Shared library'}
          >
            <EmptyState
              size="sm"
              icon={WifiOff}
              title="This computer is offline"
              description="Current files and skills are unavailable; saved conversations and result diffs remain readable."
              action={
                <Button variant="outline" onClick={closeDiff}>
                  Close panel
                </Button>
              }
            />
          </PanelPlaceholder>
        )}
      {panel === 'diff' && !creating && diffReview && diffTarget && (
        <Suspense
          fallback={
            <PanelPlaceholder kind="diff" icon={FileCode2} title="Saved diff">
              <StatusMessage tone="loading" className="p-3">
                Loading saved diff…
              </StatusMessage>
            </PanelPlaceholder>
          }
        >
          <ReviewDiff
            key={entityKey(diffReview)}
            review={diffReview}
            selectedPath={diffTarget.path}
            onSelectPath={path =>
              setDiffTarget({ reviewId: diffReview.id, path })
            }
            onClose={closeDiff}
            onFiles={() => setPanel('files')}
          />
        </Suspense>
      )}
      {panel === 'files' &&
        !browsing &&
        !creating &&
        selected &&
        store.hostReady(selectedHostId) && (
          <Suspense
            fallback={
              <PanelPlaceholder
                kind="files-tree"
                icon={FolderOpen}
                title="Files"
              >
                <StatusMessage tone="loading" className="p-3">
                  Loading files…
                </StatusMessage>
              </PanelPlaceholder>
            }
          >
            <WorkspaceFiles
              key={selectedKey}
              session={selected}
              api={desktopApi(selectedHostId)}
              savedVersion={diffReview?.version}
              onSavedDiff={() => setPanel('diff')}
              onClose={closeDiff}
            />
          </Suspense>
        )}
      {panel === 'pull-request' &&
        pullRequestTarget &&
        !creating &&
        (pullRequestsView || (!browsing && selected)) &&
        pullRequestApi(pullRequestTarget.hostId) && (
          <Suspense
            fallback={
              <PanelPlaceholder
                kind="pull-request"
                icon={GitPullRequest}
                title="Pull request"
              >
                <StatusMessage tone="loading" className="p-3">
                  Loading pull request…
                </StatusMessage>
              </PanelPlaceholder>
            }
          >
            <PullRequestPanel
              key={referenceKey(pullRequestTarget)}
              target={pullRequestTarget}
              api={desktopApi(pullRequestTarget.hostId)}
              blockedReason={pullRequestBlockedReason(pullRequestTarget.hostId)}
              linkedSession={checkoutSession}
              sendTargetTitle={threadTarget?.title ?? ''}
              onSendToSession={sendToSession}
              onLinked={session => store.merge([session])}
              onClose={closeDiff}
            />
          </Suspense>
        )}
      {panel === 'skills' &&
        !browsing &&
        !creating &&
        selected &&
        store.hostReady(selectedHostId) && (
          <Suspense
            fallback={
              <PanelPlaceholder
                kind="skills"
                icon={BookOpen}
                title="Shared library"
              >
                <StatusMessage tone="loading" className="p-3">
                  Loading skills…
                </StatusMessage>
              </PanelPlaceholder>
            }
          >
            <SessionSkills
              key={selectedKey}
              session={selected}
              api={desktopApi(selectedHostId)}
              onClose={closeDiff}
            />
          </Suspense>
        )}
      {newWorkflow && (
        <NewWorkflowSheet
          hostId={newWorkflow.hostId}
          directory={newWorkflow.directory}
          computers={store.computers}
          existingNames={async (hostId, directory) =>
            (
              await window.nesvo.workflows.listDefinitions(hostId, {
                directory,
              })
            ).workflows.map(workflow => workflow.name)
          }
          onManageComputers={() => setSettingsPage('computers')}
          onCreate={createWorkflow}
          onClose={() => setNewWorkflow(null)}
        />
      )}
      {editor && (
        <AutomationEditor
          key={editor.initial.id}
          initial={editor.initial}
          job={editorJob}
          editing={!!editor.jobKey}
          computers={automationComputers}
          statuses={hostId => store.providerStates(hostId)}
          onRefreshProvider={(provider, hostId) =>
            void store.refreshProvider(provider, hostId)
          }
          onManageComputers={() => setSettingsPage('computers')}
          onSave={(hostId, input, expectedRevision) =>
            window.nesvo.scheduledJobs.save(hostId, input, expectedRevision)
          }
          onRecover={async (hostId, id) => {
            await automations.reload(hostId);
            return (await window.nesvo.scheduledJobs.list(hostId)).find(
              job => job.id === id,
            );
          }}
          onSaved={job => {
            automations.mergeJobs([job]);
            setEditor(null);
            openAutomations(entityKey(job));
          }}
          onClose={() => setEditor(null)}
        />
      )}
      {settingsPage && (
        <Settings
          page={settingsPage}
          onPageChange={setSettingsPage}
          fallbackFocus={navigationToggle}
          onOpenChange={open => {
            if (!open) setSettingsPage(null);
          }}
        >
          {(page, onBusyChange) =>
            page === 'general' ? (
              <GeneralSettings
                connection={connection}
                computer={selectedComputer}
                hostId={selectedHostId}
                providerStates={store.providerStates(selectedHostId)}
                onRefreshConnection={() => void store.refresh(selectedHostId)}
                onRefreshProvider={provider =>
                  void store.refreshProvider(provider, selectedHostId)
                }
              />
            ) : page === 'appearance' ? (
              <AppearanceSettings api={desktopApi()} />
            ) : page === 'shortcuts' ? (
              <KeyboardShortcutsSettings />
            ) : page === 'defaults' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <DefaultsSettings
                  providerStates={store.providerStates(settingsHostId)}
                  computerName={settingsComputer?.name ?? 'Local'}
                  hostId={settingsHostId}
                  profiles={profilesFor(settingsHostId)}
                  connected={store.hostReady(settingsHostId)}
                  api={desktopApi(settingsHostId)}
                />
              </div>
            ) : page === 'notifications' ? (
              <NotificationsSettings />
            ) : page === 'data' ? (
              <DataSettings api={desktopApi()} computers={store.computers} />
            ) : page === 'about' ? (
              <AboutSettings api={desktopApi()} computers={store.computers} />
            ) : page === 'computers' ? (
              <ManageComputers
                computers={store.computers}
                api={desktopApi()}
                onBusyChange={onBusyChange}
              />
            ) : page === 'phone' ? (
              <MobileAccess api={desktopApi()} />
            ) : page === 'components' ? (
              ComponentCatalog && (
                <Suspense fallback={null}>
                  <ComponentCatalog />
                </Suspense>
              )
            ) : (
              <div className="space-y-4">
                {settingsComputerSelect}
                <ProviderProfileSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  profiles={profileCatalog.catalogs[settingsHostId]?.profiles}
                  catalogError={profileCatalog.catalogs[settingsHostId]?.error}
                  api={desktopApi(settingsHostId)}
                  onChange={profiles =>
                    profileCatalog.update(settingsHostId, profiles)
                  }
                />
              </div>
            )
          }
        </Settings>
      )}
      <ConfirmDialog
        open={leaveEditor !== null}
        onOpenChange={open => {
          if (!open) setLeaveEditor(null);
        }}
        title="Leave the graph editor?"
        description="The workflow has unsaved changes. Leaving drops the edits made since the last save."
        cancelLabel="Keep editing"
        confirmLabel="Discard and leave"
        onConfirm={() => {
          const proceed = leaveEditor;
          setEditorDirty(false);
          proceed?.();
        }}
      />
    </div>
  );
}
