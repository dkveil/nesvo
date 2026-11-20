import { isCostBudgetRefusal } from '@/shared/lib/cost-budget-refusal';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TransitionEvent,
} from 'react';
import type {
  ConversationIdentity,
  CreateSessionInput,
  SessionGroup,
  DecideDelegationInput,
  DecideSessionParentInput,
  DecideWorkerPlanInput,
  DecideReviewInput,
  DesktopReview as Review,
  DesktopSession as Session,
  ForkSessionInput,
  CodeComment,
  MessageAttachment,
  PullRequestReference,
  RespondApprovalInput,
  SessionMode,
  StartWorkflowTaskInput,
  WorkflowImportOffer,
} from '@nesvo/contracts';
import {
  AGENT_REVIEW_BRANCH_PREFIX,
  isGroupableSession,
  routesToParent,
} from '@nesvo/contracts';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookOpen,
  FileCode2,
  FileDown,
  FolderCheck,
  ListChecks,
  FolderInput,
  FolderOpen,
  Gauge,
  GitCompareArrows,
  GitFork,
  GitMerge,
  GitPullRequest,
  History,
  Menu,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  SquareDashed,
  SquareTerminal,
  Trash2,
  WifiOff,
} from 'lucide-react';
import {
  directoryLabel,
  errorDetail,
  folderBlocker,
  providerModes,
  providerStatusLabel,
  sessionFilterKeys,
  sessionMarkdown,
  sessionMarkdownFileName,
  sessionRoleLabel,
  sessionStatusLabel,
  type Provider,
} from '@/entities/session';
import { showsRunStatus } from '@/entities/workflow';
import type { EditorTarget } from '@/widgets/workflow-definitions';
import type { AssistantContext } from '@/widgets/workflow-assistant';
import type { AssistantChange } from '@nesvo/contracts';
import {
  NewWorkflowDialog,
  type NewWorkflowDraft,
} from '@/features/new-workflow/new-workflow-dialog';
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
import { useDefaultSessionFolders } from '@/features/default-session-folder';
import { HistorySearchDialog } from '@/features/search-history';
import { ImportConversation } from '@/features/import-conversation';
import { ManagerImportPicker } from '@/features/import-manager';
import { ImportWorkflowDialog } from '@/features/import-workflow';
import {
  ShareWorkflowDialog,
  type ShareTarget,
} from '@/features/share-workflow';
import {
  CommandPalette,
  type PaletteCommand,
  type PaletteMode,
} from '@/features/command-palette';
import { SessionCleanup } from '@/features/clean-up-sessions';
import { SessionDeletion } from '@/features/delete-session';
import { RenameSessionDialog } from '@/features/rename-session';
import { MoveToGroupDialog } from '@/widgets/session-sidebar/move-to-group-dialog';
import { shortcutKeys } from '@/shared/lib/keyboard-shortcuts';
import { MobileAccess } from '@/features/mobile-access';
import { entityKey, hostKey } from '@/shared/lib/host-key';
import {
  hasEarlierMessages,
  listSubsessions,
  subsessionOverview,
  terminalResume,
} from '@nesvo/contracts';
import {
  TerminalCommandDialog,
  TerminalHandoffNotice,
} from '@/features/session-terminal';
import type { SelectedSkill } from '@/features/select-skill';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { BranchChip } from '@/features/git-branch/branch-chip';
import {
  RunningAppsChip,
  RunningAppsSection,
} from '@/features/running-apps/running-apps-chip';
import { useRunningApps } from '@/features/running-apps/use-running-apps';
import { useRunningAppsEnabled } from '@/features/running-apps/use-running-apps-enabled';
import { useGitBranch } from '@/features/git-branch/use-git-branch';
import { FinishWorktreeDialog } from '@/features/session-worktree/finish-worktree';
import { ForkWorktreeDialog } from '@/features/session-worktree/fork-worktree';
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { ProjectChip } from '@/shared/ui/project-chip';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Separator } from '@/shared/ui/separator';
import {
  Sheet,
  LeftSheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/ui/sheet';
import { StatusMessage } from '@/shared/ui/status-message';
import { Conversation, type ModelSelection } from '@/widgets/conversation';
import type { FileTarget } from '@/widgets/conversation/message-link-target';
import { Delegations } from '@/widgets/delegations';
import { ChildWorkDrawer } from '@/widgets/delegations/child-work-drawer';
import {
  CoordinatorWakeFooter,
  CoordinatorWakeSetting,
} from '@/widgets/delegations/coordinator-wake';
import { useCoordinatorWake } from '@/widgets/delegations/use-coordinator-wake';
import { useFlowWake } from '@/widgets/workflow-flows/use-flow-wake';
import { CoordinatorWait } from '@/widgets/delegations/coordinator-wait';
import { WorkflowStatus } from '@/widgets/workflow-status';
import { ReviewInbox } from '@/widgets/review-inbox';
import { useInboxGateRules } from '@/widgets/review-inbox/use-inbox-gate-rules';
import { ChildDecisions } from '@/widgets/child-decisions';
import {
  resolveDecisionRoute,
  useInboxItems,
  type HostedInboxItem,
} from '@/features/inbox-rules';
import { StageRecord, useStageDecisions } from '@/widgets/session-stages';
import { PermissionSettings } from '@/widgets/settings/permission-settings';
import { RepositoryTrustSettings } from '@/widgets/settings/repository-trust-settings';
import { ProviderUsageGateSettings } from '@/widgets/settings/provider-usage-gate-settings';
import { ReadonlyIntegrationsSettings } from '@/widgets/settings/readonly-integrations-settings';
import { FullAccessDialog } from '@/features/session-mode/full-access-dialog';
import { PermissionRules } from '@/features/session-mode/permission-rules';
import { useClaudeAutonomy } from '@/features/session-mode/use-claude-autonomy';
import { ClaudeTerminal } from '@/widgets/claude-terminal';
import { SessionDetails } from '@/widgets/session-details';
import { WorktreeRecipesSettings } from '@/widgets/worktree-recipes-settings';
import { WorktreeProviderSettings } from '@/widgets/settings/worktree-provider-settings';
import {
  useSessionWorktreeRecipe,
  WorktreeRecipeCard,
  WorktreeRecipeResources,
} from '@/features/worktree-recipe';
import {
  isRecipeHolding,
  supportsWorktreeRecipes,
} from '@/entities/worktree-recipe';
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
  PullRequestSection,
  SubsessionsSection,
} from '@/widgets/session-card';
import { SubsessionBar } from '@/widgets/session-subsessions';
import { ProviderUsage } from '@/widgets/provider-rail';
import { ProviderProfileSettings } from '@/widgets/provider-rail/provider-profile-settings';
import { CodeReviewSettings } from '@/widgets/code-review-settings';
import { TrackedRepositoriesSettings } from '@/widgets/tracked-repositories-settings';
import { SessionControlSettings } from '@/widgets/session-control-settings';
import { useSessionIngressHistory } from '@/features/session-ingress/use-session-ingress-history';
import { ExternalSessionSettings } from '@/widgets/settings/external-session-settings';
import { SessionWatcherSettings } from '@/widgets/settings/session-watcher-settings';
import {
  SessionIngressDetails,
  SessionIngressItems,
} from '@/features/session-ingress/session-ingress-history';
import { GateRuleSettings } from '@/features/gate-rules/gate-rule-settings';
import { LessonsSettings } from '@/widgets/lessons-settings';
import { LessonInbox } from '@/widgets/lesson-inbox';
import { InboxRulesSettings } from '@/widgets/inbox-rules-settings';
import { DevicesSettings } from '@/widgets/settings/devices-settings';
import {
  ConfigurationDevicesSettings,
  ConfigurationHistorySettings,
} from '@/widgets/settings/configuration-settings';
import { useProfileStatus } from '@/features/provider-profiles/use-profile-status';
import { Chip } from '@/shared/ui/chip';
import {
  pendingStageQuestion,
  pendingTurnQuestion,
  routesToInbox,
} from '@nesvo/contracts';
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
  SharingSettings,
  type SettingsPage,
} from '@/widgets/settings';
import { AutomationDetail, AutomationList } from '@/widgets/automations';
import type { ScheduledJob, ScheduledJobRun } from '@/entities/scheduled-job';
import { cn } from '@/shared/lib/cn';
import { desktopApi, useSessions } from './use-sessions';
import { supportsScheduledJobs, useScheduledJobs } from './use-scheduled-jobs';
import { readDrafts, writeDrafts } from './draft-store';
import { SessionWorkflowChip } from '@/features/session-workflow';
import { attachmentSupport } from '@/features/attach-files/attachment-support';
import { useComposerAttachments } from '@/features/attach-files/use-composer-attachments';
import {
  addCodeComment,
  clearCodeComments,
  readyCodeComments,
  restoreCodeComments,
} from '@/features/code-comments/store';
import type { AgentCommentTarget } from '@/features/code-comments/agent-target';
import { ChangesRow } from '@/features/session-changes/changes-row';
import {
  placeInText,
  withoutPlacement,
} from '@/features/attach-files/placement';
import { McpChip } from '@/features/session-mcp/mcp-chip';
import { useMcpConnections } from '@/features/session-mcp/use-mcp-connections';
import { McpSettings } from '@/widgets/settings/mcp-settings';
import {
  McpRepositoryNotice,
  RepositoryDecision,
} from '@/features/session-mcp/mcp-repository-notice';
import { PanelBody } from '@/shared/ui/panel';
import { useMcpConfiguration } from '@/features/session-mcp/use-mcp-configuration';
import { SetupProfileSettings } from '@/widgets/settings/setup-profile-settings';
import { useSetupDrift } from '@/widgets/settings/use-setup-drift';
import {
  NewSessionSetupFinding,
  SetupFindings,
} from '@/widgets/settings/setup-findings';
import {
  AuthoritySettingsContext,
  type SettingsAuthorityReview,
} from '@/features/configuration/authority-review';
import { CompactInstructionsDialog } from '@/features/conversation-context/compact-instructions-dialog';
import { ContextMeter } from '@/features/conversation-context/context-meter';
import { conversationActions } from '@/features/conversation-context/conversation-actions';
import type { PromptSkill } from '@nesvo/contracts';
import { ResumeSessionDialog } from '@/features/resume-session/resume-session-dialog';
import { ResumeSessionsDialog } from '@/features/resume-session/resume-sessions-dialog';
import { resumeCandidates } from '@/features/resume-session/resume-candidates';
import { FinishAfterMergeDialog } from '@/features/merged-worktree-cleanup/finish-after-merge-dialog';
import {
  canFinishAfterMerge,
  mergedCleanupCandidates,
} from '@/features/merged-worktree-cleanup/merged-candidates';
import { cachedPullRequest } from '@/entities/pull-request';
import { SessionPullRequest } from '@/features/session-pull-request';
import { PullRequestCard } from '@/features/session-pull-request/pull-request-card';
import {
  pullRequestsUnavailableReason,
  referenceKey,
  sameReference,
  type PullRequestTarget,
} from '@/entities/pull-request';
import { PullRequestsView } from '@/widgets/pull-requests';
import type { PullRequestPanelLayout } from '@/widgets/pull-request';
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
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
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
const SessionChangesPanel = lazy(() => import('@/widgets/session-changes'));

const isAgentReviewSession = (session: Session) =>
  !!session.pullRequest &&
  !!session.worktree?.branch.startsWith(AGENT_REVIEW_BRANCH_PREFIX);

const DRAFT_LIMIT_CHARACTERS = 32_000;

const WorkflowDefinitions = lazy(
  () => import('@/widgets/workflow-definitions'),
);

const WorkflowFlows = lazy(() => import('@/widgets/workflow-flows'));

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

export function Workspace({
  onOpenOnboarding,
  initialSessionProvider,
}: {
  onOpenOnboarding: () => void;
  initialSessionProvider?: Provider | null;
}) {
  const store = useSessions();
  const defaultFolders = useDefaultSessionFolders(store.computers);
  const [location] = useState(readWorkspaceLocation);
  const [selectedId, setSelectedId] = useState(location.selectedId);
  const [inbox, setInbox] = useState(location.inbox);
  const [inboxLink, setInboxLink] = useState<{
    hostId: string;
    id: string;
  } | null>(null);
  const [fileLink, setFileLink] = useState<
    (FileTarget & { sessionKey: string; request: string }) | null
  >(null);
  const [costsView, setCostsView] = useState(false);
  const [showBudgets, setShowBudgets] = useState(false);
  const [automation, setAutomation] = useState(location.automation);
  const [assistantDrawerHost, setAssistantDrawerHost] =
    useState<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<{
    initial: AutomationValues;
    jobKey: string;
    navigation: number;
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
    | 'diff'
    | 'files'
    | 'skills'
    | 'pull-request'
    | 'changes'
    | 'terminal'
    | 'details'
    | 'context'
    | 'child-work'
    | null
  >(location.diff ? 'diff' : null);
  const [childWork, setChildWork] = useState<{
    hostId: string;
    coordinatorId: string;
    childId: string;
    runId: string | null;
  } | null>(null);
  const [feedbackNotice, setFeedbackNotice] = useState<{
    key: string;
    text: string;
    warning: boolean;
  } | null>(null);
  const [pullRequestsView, setPullRequestsView] = useState(false);
  const [pullRequestHandoff, setPullRequestHandoff] = useState<Session | null>(
    null,
  );
  const [pullRequestTarget, setPullRequestTarget] =
    useState<PullRequestTarget | null>(null);
  const [pullRequestLayout, setPullRequestLayout] =
    useState<PullRequestPanelLayout>('surface');
  const [workflowPage, setWorkflowPage] = useState<
    'workflows' | 'flows' | null
  >(null);
  const workflowsView = workflowPage !== null;
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
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [importOffers, setImportOffers] = useState<WorkflowImportOffer[]>([]);
  useEffect(() => {
    const sharing = window.nesvo.sharing;
    const take = () =>
      void sharing.takeImports().then(
        offers => {
          if (offers.length)
            setImportOffers(current => [...current, ...offers]);
        },
        () => undefined,
      );
    take();
    return sharing.onImportAvailable(take);
  }, []);
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
          setWorkflowPage('workflows');
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
          setWorkflowPage('workflows');
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
          drawerHost={assistantDrawerHost}
          blocked={
            !!editor || !!newWorkflow || (!!automation && automation !== 'list')
          }
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
    const navigation = navigationVersion.current;
    const catalog = await window.nesvo.workflows.listDefinitions(draft.hostId, {
      directory: draft.directory,
    });
    if (navigationVersion.current !== navigation) return;
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
  const [runningAppsEnabled] = useRunningAppsEnabled();
  const [sidebar, setSidebar] = useState(() => ({
    open: readSidebarOpen(),
    moving: false,
  }));
  const sidebarOpen = sidebar.open;
  const sidebarShown = sidebar.open || sidebar.moving;
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const visibleSidebarWidth = clampSidebarWidth(sidebarWidth, viewportWidth);
  const sidebarToggle = useRef<HTMLButtonElement | null>(null);
  const navigationToggle = useRef<HTMLButtonElement | null>(null);
  const headerRef = useRef<HTMLElement>(null);
  const headerActionsTrigger = useRef<HTMLButtonElement>(null);
  const [narrowHeader, setNarrowHeader] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const resultsTrigger = useRef<HTMLButtonElement>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  const cardOpen = panel === 'details';
  const [creating, setCreating] = useState(
    initialSessionProvider !== undefined,
  );
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
      provider: initialSessionProvider ?? 'Claude Code',
      model: initialSessionProvider === 'Codex' ? '' : 'default',
      effort: '',
      mode: 'read-only',
      directory: '',
    }),
  );
  const threadFolder = defaultFolders.folders[threadSetup.hostId];
  const [filledFolderHost, setFilledFolderHost] = useState('');
  if (
    threadFolder &&
    filledFolderHost !== threadSetup.hostId &&
    !threadSetup.directory.trim()
  ) {
    setFilledFolderHost(threadSetup.hostId);
    setThreadSetup({ ...threadSetup, directory: threadFolder });
  }
  const [accountSettingsHostId, setAccountSettingsHostId] = useState<string>();
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [changedSetupHosts, setChangedSetupHosts] = useState<string[]>([]);
  useEffect(
    () =>
      window.nesvo?.subscribe(event => {
        if (
          event.type === 'configuration-changed' &&
          event.change.source.kind === 'system' &&
          event.change.target.area === 'setup-profile' &&
          event.change.status === 'applied'
        )
          setChangedSetupHosts(previous =>
            previous.includes(event.hostId)
              ? previous
              : [...previous, event.hostId],
          );
      }),
    [],
  );
  const [editProfileRouting, setEditProfileRouting] = useState(false);
  const [setupReviewDirectory, setSetupReviewDirectory] = useState<string>();
  const [authoritySettings, setAuthoritySettings] =
    useState<SettingsAuthorityReview | null>(null);
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
  const supportsResume = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('session-resume');
  const supportsMergedCleanup = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('merged-worktree-cleanup');
  const supportsCompaction = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('conversation-compaction');
  const supportsInlineAttachments = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('inline-attachments');
  const codeCommentsBlockedReason = (target: Session | null) => {
    if (!target) return 'Open a session to send comments to the agent.';
    return store.computers
      .find(computer => computer.id === target.hostId)
      ?.capabilities.includes('code-comments')
      ? ''
      : 'Update this computer’s Nesvo host to send code comments to the agent.';
  };
  const agentCommentsFor = (
    target: Session | null,
    preferred: boolean,
    onAdded: (target: Session) => void,
  ): AgentCommentTarget => ({
    title: target?.title ?? '',
    blockedReason: codeCommentsBlockedReason(target),
    preferred,
    add: comment => {
      if (!target || !addCodeComment(entityKey(target), comment)) return false;
      onAdded(target);
      return true;
    },
  });
  const supportsSessionChanges = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('session-changes');
  const supportsModes = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('permission-modes');
  const pendingModeOf = (target: Session) => {
    if (!supportsModes(target.hostId)) return null;
    const mode = modeSelections[entityKey(target)] ?? null;
    return mode === 'full-access' && !autonomy.data?.fullAccessEnabled
      ? null
      : mode;
  };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [restartTarget, setRestartTarget] = useState<Session | null>(null);
  const [resumeTarget, setResumeTarget] = useState<{
    session: Session;
    messageId: string;
  } | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [bulkResumeOpen, setBulkResumeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<Session | null>(null);
  const [forkTarget, setForkTarget] = useState<Session | null>(null);
  const [restartError, setRestartError] = useState('');
  const [compactTarget, setCompactTarget] = useState<Session | null>(null);
  const [compactError, setCompactError] = useState('');
  const [finishingWorktree, setFinishingWorktree] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [moveTarget, setMoveTarget] = useState<Session | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
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
  const [parentPending, setParentPending] = useState<Record<string, boolean>>(
    {},
  );
  const stages = useStageDecisions({
    api: desktopApi,
    merge: sessions => store.merge(sessions),
    isEnabled: session =>
      !store.loading && !store.error && store.hostReady(session.hostId),
    modesFor: session =>
      providerModes(
        session.provider,
        store.providerStates(session.hostId)[session.provider].status,
      ),
  });
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
  const inboxRules = useInboxItems(store.computers);
  const inboxGateRules = useInboxGateRules(store.computers);
  const routeOf = (session: Session) =>
    resolveDecisionRoute(
      session,
      store.groups(session.hostId),
      inboxRules.defaultRoute(session.hostId),
    );
  const parentStages = useStageDecisions({
    api: desktopApi,
    merge: sessions => store.merge(sessions),
    isEnabled: session =>
      !store.loading && !store.error && store.hostReady(session.hostId),
    modesFor: session =>
      providerModes(
        session.provider,
        store.providerStates(session.hostId)[session.provider].status,
      ),
    via: 'parent',
  });
  const openRuleChanges = (item: HostedInboxItem) => {
    if (!item.sessionId) return;
    const key = hostKey(item.sessionId, item.hostId);
    guardEditor(() => {
      selectNow(key);
      setPanel('changes');
    });
  };
  const openRulePullRequest = (
    item: HostedInboxItem,
    reference: PullRequestReference,
  ) => openPullRequestSurface({ hostId: item.hostId, reference });
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
  const importFolders = [
    ...new Set(
      [
        workflowsSource.hostId === 'local' ? workflowsSource.directory : '',
        ...store.sessions
          .filter(session => session.hostId === 'local')
          .map(
            session => session.worktree?.projectDirectory ?? session.directory,
          ),
      ].filter(Boolean),
    ),
  ].slice(0, 12);
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
  const supportsAutonomy = (hostId: string) =>
    store.hostReady(hostId) &&
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('claude-autonomy');
  const autonomy = useClaudeAutonomy(
    selectedHostId,
    supportsAutonomy(selectedHostId),
  );
  const [fullAccessTarget, setFullAccessTarget] = useState<Session | null>(
    null,
  );
  const selectedIdForReviews = selected?.id;
  const hostReviews = useMemo(
    () => store.reviews.filter(review => review.hostId === selectedHostId),
    [store.reviews, selectedHostId],
  );
  const selectedReviews = useMemo(
    () =>
      hostReviews.filter(review => review.sessionId === selectedIdForReviews),
    [hostReviews, selectedIdForReviews],
  );
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
  const orchestration = !!selectedComputer?.capabilities.includes(
    'coordinator-orchestration',
  );
  const coordinatorChildren = selected
    ? store.sessions.filter(
        child =>
          child.hostId === selected.hostId && child.parentId === selected.id,
      )
    : [];
  const wakeControl = useCoordinatorWake(
    orchestration &&
      workflowPage !== 'flows' &&
      selected &&
      coordinatorChildren.length &&
      store.hostReady(selectedHostId)
      ? window.nesvo
      : undefined,
    selectedHostId,
    selected?.id ?? null,
  );
  const flowWake = useFlowWake(
    store.computers,
    store.sessions,
    workflowPage === 'flows',
  );
  const inspectedChild =
    childWork &&
    store.sessions.find(
      child =>
        child.hostId === childWork.hostId &&
        child.id === childWork.childId &&
        child.parentId === childWork.coordinatorId,
    );
  const inspectChild = (
    child: Session,
    trigger: HTMLElement,
    runId?: string,
  ) => {
    if (!selected || !orchestration || child.parentId !== selected.id) return;
    diffTrigger.current = trigger;
    setDiffTarget(null);
    setChildWork({
      hostId: selected.hostId,
      coordinatorId: selected.id,
      childId: child.id,
      runId: runId ?? null,
    });
    setPanel('child-work');
  };
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
  const supportsMcpTrust = !!selectedComputer?.capabilities.includes(
    'repository-mcp-trust',
  );
  const isolatedMcp = !!(
    selected?.parentId ||
    selected?.role === 'worker' ||
    selected?.workflowRunId ||
    selected?.workflowStepId ||
    selected?.scheduledJobId
  );
  const mcpConfiguration = useMcpConfiguration(
    selectedHostId,
    selected?.id,
    supportsMcpTrust && !isolatedMcp && selected
      ? selected.runId + ':' + selected.status
      : null,
    connection === 'ready' && supportsMcp(selectedHostId),
  );
  const [externalReceipt, setExternalReceipt] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const externalEntries = useSessionIngressHistory(
    selectedHostId,
    selected?.id,
    connection === 'ready' &&
      !!selectedComputer?.capabilities.includes('external-session-messages'),
  );
  const [repositoryReviewKey, setRepositoryReviewKey] = useState<string | null>(
    null,
  );
  const reviewRepository = mcpConfiguration.list?.repository;
  const mcpConnections = useMcpConnections(
    selectedHostId,
    selected ? { sessionId: selected.id } : undefined,
    connection === 'ready' &&
      !isolatedMcp &&
      !!selectedComputer?.capabilities.includes('mcp-auth'),
  );
  const parentSession = store.sessions.find(
    session =>
      session.id === selected?.parentId && session.hostId === selected?.hostId,
  );
  const workers = store.sessions.filter(
    session =>
      session.parentId === selected?.id && session.hostId === selected?.hostId,
  );
  const hostSessions = store.sessions.filter(
    session => session.hostId === selected?.hostId,
  );
  const subsessions = selected ? listSubsessions(selected, hostSessions) : [];
  const subsessionActivity = selected
    ? subsessionOverview(selected, hostSessions)
    : null;
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
  const activeRun = !selected
    ? undefined
    : selected.status === 'running' || selected.status === 'stopping'
      ? selected
      : folderBlocker(selected, store.sessions);
  const sessionRecipe = useSessionWorktreeRecipe(
    selected?.worktree &&
      supportsWorktreeRecipes(selectedComputer) &&
      store.hostReady(selectedHostId)
      ? desktopApi(selectedHostId)
      : undefined,
    selected?.worktree ? selected.id : undefined,
    `${selected?.worktree?.state ?? ''}:${selected?.status ?? ''}`,
  );
  const folderBusy =
    !!activeRun || !!selected?.waitingFor || isRecipeHolding(sessionRecipe.run);
  const waitingSessionId = selected?.waitingFor
    ? selected.waitingFor.sessionId
    : activeRun?.id;
  const blockingSession = store.sessions.find(
    session =>
      session.id === waitingSessionId &&
      session.id !== selected?.id &&
      session.hostId === selectedHostId,
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
  const visiblePanel =
    !!editor?.jobKey ||
    (automation && automation !== 'list') ||
    (panel === 'diff' && !diffReview ? null : panel);
  const cardSession = !browsing && !creating && selected ? selected : null;
  const panelBesideSession =
    !!cardSession && !!visiblePanel && viewportWidth >= 1200;
  const compactSessionHeader = panelBesideSession && narrowHeader;
  const headerIconSize = compactSessionHeader ? 24 : 32;
  const cardRun = cardSession ? selectedRun : undefined;
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(() =>
      setNarrowHeader(header.clientWidth < 640),
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
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
  const setSidebarOpen = useCallback((open: boolean) => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    setSidebar(current =>
      current.open === open ? current : { open, moving: !reducedMotion },
    );
  }, []);
  const settleSidebar = (event: TransitionEvent<HTMLDivElement>) => {
    if (
      event.target === event.currentTarget &&
      event.propertyName === '--sidebar-extent'
    )
      setSidebar(current => ({ ...current, moving: false }));
  };
  const toggleSidebar = useCallback(
    (open: boolean) => {
      setSidebarOpen(open);
      requestAnimationFrame(() => sidebarToggle.current?.focus());
    },
    [setSidebarOpen],
  );
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
    () =>
      sessionFilterKeys(
        store.sessions,
        store.reviews,
        store.workflowRuns,
        new Set([
          ...inboxRules.items.flatMap(item =>
            item.status === 'pending' &&
            item.action !== 'notify' &&
            item.sessionId
              ? [hostKey(item.sessionId, item.hostId)]
              : [],
          ),
          ...inboxGateRules.rows.flatMap(({ hostId, proposal }) =>
            proposal.status === 'pending'
              ? [hostKey(proposal.taskSessionId ?? proposal.sessionId, hostId)]
              : [],
          ),
        ]),
      ),
    [
      store.sessions,
      store.reviews,
      store.workflowRuns,
      inboxRules.items,
      inboxGateRules.rows,
    ],
  );
  const sessionAttention =
    selected && filterKeys['needs-me'].has(selectedKey)
      ? pendingStageQuestion(selected) || pendingTurnQuestion(selected)
        ? 'Question for you'
        : selectedReviews.some(review => review.status === 'pending')
          ? 'Result to review'
          : 'Decision needed'
      : '';
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
    setDiffTarget({ reviewId, path });
    setPanel('diff');
  };
  const openFiles = () => {
    setFileLink(null);
    diffTrigger.current = panelTrigger();
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
  const openChanges = () => {
    diffTrigger.current = panelTrigger();
    setPanel(panel === 'changes' ? null : 'changes');
  };
  const closeCard = () => {
    setPanel(current => (current === 'details' ? null : current));
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
    setPanel('details');
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
    setEditor(null);
    setNewWorkflow(null);
    navigationVersion.current += 1;
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setSelectedId(id);
    setSessionTarget(targetId);
    setResultsOpen(targetId.startsWith('review-'));
    setMessageTarget(null);
    setInbox(false);
    setCostsView(false);
    setWorkflowPage(null);
    setPullRequestsView(false);
    setAutomation('');
    setNavigationOpen(false);
  };
  const openInbox = () =>
    guardEditor(() => {
      setInboxLink(null);
      openInboxNow();
    });
  const openInboxDiff = (review: Review) =>
    guardEditor(() => {
      selectNow(hostKey(review.sessionId, review.hostId));
      openDiff(review.id);
    });
  const replyToQuestion = async (
    session: Session,
    runId: string,
    text: string,
    messageId: string,
  ) => {
    store.merge([
      await desktopApi(session.hostId).sendMessage({
        sessionId: session.id,
        messageId,
        text,
        replyToRunId: runId,
      }),
    ]);
  };
  const openInboxNow = () => {
    setEditor(null);
    setNewWorkflow(null);
    navigationVersion.current += 1;
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(true);
    setCostsView(false);
    setWorkflowPage(null);
    setPullRequestsView(false);
    setAutomation('');
    setNavigationOpen(false);
  };
  const openWorkflows = () => guardEditor(() => openWorkflowsNow());
  const openFlows = () => guardEditor(() => openWorkflowsNow('flows'));
  const openWorkflowsNow = (page: 'workflows' | 'flows' = 'workflows') => {
    setEditor(null);
    setNewWorkflow(null);
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
    setWorkflowPage(page);
    setPullRequestsView(false);
    setNavigationOpen(false);
  };
  const openPullRequests = () => guardEditor(openPullRequestsNow);
  const openPullRequestsNow = (handoff: Session | null = null) => {
    setEditor(null);
    setNewWorkflow(null);
    navigationVersion.current += 1;
    if (handoff || panel !== 'pull-request') setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(false);
    setCostsView(false);
    setWorkflowsEditor(null);
    setWorkflowPage(null);
    setAutomation('');
    setPullRequestsView(true);
    setPullRequestHandoff(handoff);
    setNavigationOpen(false);
  };
  const openPullRequest = (
    target: PullRequestTarget,
    layout: PullRequestPanelLayout = 'surface',
  ) => {
    diffTrigger.current = panelTrigger();
    setPullRequestTarget(target);
    setPullRequestLayout(layout);
    setPanel('pull-request');
  };
  const reviewPullRequest = (target: PullRequestTarget) =>
    openPullRequest(target, 'session');
  const openPullRequestSurface = (target: PullRequestTarget) => {
    openPullRequestsNow(selected ?? null);
    setPullRequestTarget(target);
    setPullRequestLayout('surface');
    setPanel('pull-request');
  };
  const openAutomations = (target = 'list') =>
    guardEditor(() => openAutomationsNow(target));
  const openAutomationsNow = (target: string) => {
    setEditor(null);
    setNewWorkflow(null);
    navigationVersion.current += 1;
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(false);
    setCostsView(false);
    setWorkflowsEditor(null);
    setWorkflowPage(null);
    setPullRequestsView(false);
    setAutomation(target);
    setNavigationOpen(false);
  };
  const openCreate = () =>
    guardEditor(() => {
      setCreationGroup(null);
      setThreadSetup(previous =>
        applyNewSessionDefaults(
          previous,
          undefined,
          defaultFolders.folders[previous.hostId] ?? null,
        ),
      );
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
          defaultFolders.folders[hostId] ?? null,
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
    setPanel(null);
    setDiffTarget(null);
    setInbox(false);
    setCostsView(false);
    setWorkflowPage(null);
    setPullRequestsView(false);
    setAutomation('');
    setCreating(true);
  };
  const openCosts = () => openCostsView(false);
  const openCostsView = (budgets: boolean) =>
    guardEditor(() => {
      navigationVersion.current += 1;
      setPanel(null);
      setDiffTarget(null);
      setCreating(false);
      setInbox(false);
      setWorkflowsEditor(null);
      setWorkflowPage(null);
      setPullRequestsView(false);
      setAutomation('');
      setNavigationOpen(false);
      setShowBudgets(budgets);
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
    codeComments: readonly CodeComment[] = [],
  ) => {
    const sessionId = target.id;
    const attachmentIds = [...attachments, ...codeComments]
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
        ...(codeComments.length ? { codeComments: [...codeComments] } : {}),
      });
      store.merge([session]);
      acknowledge();
    } catch (failure) {
      const detail = errorDetail(failure);
      if (isCostBudgetRefusal(detail)) {
        delete sendAttempts.current[sessionKey];
        setErrors(previous => ({ ...previous, [sessionKey]: detail }));
        return;
      }
      setErrors(previous => ({
        ...previous,
        [sessionKey]: `Could not confirm that the message was sent. ${detail}`,
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
      !folderBusy &&
      selected.status !== 'running' &&
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
    const codeComments = readyCodeComments(
      sessionKey,
      Math.max(0, draft.indexOf(text)),
      text.length,
    );
    const version = draftVersions.current[sessionKey] ?? 0;
    const skill = typed?.skill ?? selectedSkills[sessionKey] ?? null;
    const selection = modelSelections[sessionKey] ?? null;
    const mode = pendingModeOf(selected);
    const running =
      selected.status === 'running' || selected.status === 'stopping';
    if (
      orchestration &&
      selected.parentId &&
      selected.runId &&
      selected.status === 'running' &&
      !skill &&
      !selection &&
      !mode &&
      !attachments.length &&
      !codeComments.length
    ) {
      sendingRef.current = true;
      setSending(true);
      setFeedbackNotice(null);
      try {
        const result = await window.nesvo.steerChildSession(
          {
            sessionId: selected.id,
            expectedRunId: selected.runId,
            text,
            fallback: 'queue',
            actionId: crypto.randomUUID(),
          },
          selected.hostId,
        );
        const warning = result.status === 'delivery-unknown';
        setFeedbackNotice({
          key: sessionKey,
          warning,
          text:
            result.status === 'steered'
              ? 'Steered'
              : result.status === 'queued'
                ? `Queued. ${result.reason}`
                : warning
                  ? 'Delivery unconfirmed'
                  : 'Feedback is waiting for a decision.',
        });
        if ((draftVersions.current[sessionKey] ?? 0) === version)
          setDrafts(previous => ({ ...previous, [sessionKey]: '' }));
      } catch (error) {
        setFeedbackNotice({
          key: sessionKey,
          warning: true,
          text: errorDetail(error),
        });
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
      return;
    }
    await deliver(
      selected,
      text,
      skill,
      () => {
        clearModelSelection(sessionKey, selection);
        clearModeSelection(sessionKey, mode);
        composerAttachments.clear(sessionKey, attachments);
        clearCodeComments(sessionKey, codeComments);
        if ((draftVersions.current[sessionKey] ?? 0) === version) {
          setDrafts(previous => ({ ...previous, [sessionKey]: '' }));
          setSelectedSkills(previous => ({ ...previous, [sessionKey]: null }));
        }
      },
      folderBusy || running,
      selection,
      mode,
      attachments,
      codeComments,
    );
  };
  const resend = async () => {
    if (!selected || sendingRef.current || connection !== 'ready' || folderBusy)
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
      last.codeComments,
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
    if (entry?.codeComments) restoreCodeComments(key, entry.codeComments);
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
      await deliver(
        session,
        text,
        skill,
        () => {
          if ((draftVersions.current[key] ?? 0) === version) {
            setDrafts(previous => ({ ...previous, [key]: '' }));
            setSelectedSkills(previous => ({ ...previous, [key]: null }));
          }
        },
        !!session.worktree &&
          supportsWorktreeRecipes(
            store.computers.find(computer => computer.id === hostId),
          ),
      );
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
  const threadBusyReason =
    store.loading || store.error ? 'Session history is still loading.' : '';
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
      if (input.allowScope && hostId === selectedHostId)
        void autonomy.execute({ action: 'read' }).catch(() => undefined);
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
  const [restartingWorkers, setRestartingWorkers] = useState(false);
  const [workerRestartErrors, setWorkerRestartErrors] = useState<
    Record<string, string>
  >({});
  const continueWorkers = async (coordinator: Session, targets: Session[]) => {
    setRestartingWorkers(true);
    const failures: string[] = [];
    try {
      for (const worker of targets) {
        if (!worker.runId) continue;
        try {
          store.merge([
            await desktopApi(coordinator.hostId).continueWorker({
              sessionId: coordinator.id,
              workerId: worker.id,
              interruptedRunId: worker.runId,
              messageId: crypto.randomUUID(),
            }),
          ]);
        } catch (failure) {
          failures.push(`${worker.title} / ${errorDetail(failure)}`);
        }
      }
    } finally {
      setWorkerRestartErrors(previous => ({
        ...previous,
        [entityKey(coordinator)]: failures.join(' '),
      }));
      setRestartingWorkers(false);
    }
  };
  const continueCoordinator = async (session: Session) => {
    if (!session.coordinatorWait) return;
    store.merge([
      await desktopApi(session.hostId).continueCoordinator({
        sessionId: session.id,
        waitRunId: session.coordinatorWait.runId,
        messageId: crypto.randomUUID(),
      }),
    ]);
  };
  const decideSessionParent = async (
    input: DecideSessionParentInput,
    hostId = 'local',
  ) => {
    const sessionKey = hostKey(input.sessionId, hostId);
    const key = `${sessionKey}/${input.requestId}`;
    if (parentPending[key] || !store.hostReady(hostId)) return;
    setParentPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [sessionKey]: '' }));
    try {
      store.merge([await desktopApi(hostId).decideSessionParent(input)]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [sessionKey]: `Could not send the decision. ${errorDetail(failure)}`,
      }));
    } finally {
      setParentPending(previous => {
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
    if (job.redCi)
      return 'Starts when a tracked pull request has failing checks.';
    const running = runningSessions.find(
      session =>
        session.hostId === job.hostId && session.scheduledJobId === job.id,
    );
    return running ? `${automationLabel(running)} is running.` : '';
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
    setEditor({ initial, jobKey, navigation: ++navigationVersion.current });
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
  const agentReviewBlockedReason = (hostId: string) =>
    store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('pull-request-reviews')
      ? ''
      : 'Update this computer’s Nesvo host and reconnect to review pull requests with an agent.';
  const reviewDirectory =
    linkedSessions.find(session => session.worktree)?.worktree
      ?.projectDirectory ??
    (selected && selected.hostId === pullRequestTarget?.hostId
      ? (selected.worktree?.projectDirectory ?? selected.directory)
      : '');
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
  const cleanupAvailable = store.computers.some(computer =>
    housekeeping.supports(computer.id),
  );
  const openCleanup = () => {
    setNavigationOpen(false);
    setCleanupOpen(true);
  };
  const cleanupBusyKeys = useMemo(
    () => new Set([...filterKeys['needs-me'], ...filterKeys.running]),
    [filterKeys],
  );
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
  const resumeSession = async (
    target: Session,
    messageId: string,
    text: string,
    promptSkill?: PromptSkill,
  ) => {
    setThreadActionPending(true);
    setResumeError('');
    try {
      const session = await desktopApi(target.hostId).resumeSession({
        sessionId: target.id,
        messageId,
        revision: target.revision,
        text,
        ...(promptSkill ? { promptSkill } : {}),
      });
      store.merge([session]);
      const key = entityKey(session);
      setErrors(previous => ({ ...previous, [key]: '' }));
      setResumeTarget(null);
      select(key);
      return true;
    } catch (error) {
      setResumeError(errorDetail(error));
      return false;
    } finally {
      setThreadActionPending(false);
    }
  };
  const resumeFromList = async (
    target: Session,
    messageId: string,
    text: string,
    promptSkill?: PromptSkill,
  ) => {
    try {
      const session = await desktopApi(target.hostId).resumeSession({
        sessionId: target.id,
        messageId,
        revision: target.revision,
        text,
        ...(promptSkill ? { promptSkill } : {}),
      });
      store.merge([session]);
      return null;
    } catch (error) {
      return errorDetail(error);
    }
  };
  const bulkResumeCandidates = resumeCandidates({
    sessions: store.sessions.filter(
      session => !session.archivedAt && store.hostReady(session.hostId),
    ),
    supportsResume,
  });
  const latestSession = (target: Session) =>
    store.sessions.find(session => entityKey(session) === entityKey(target)) ??
    target;
  const offersFinishAfterMerge = (session: Session) =>
    supportsMergedCleanup(session.hostId) &&
    store.hostReady(session.hostId) &&
    canFinishAfterMerge(session) &&
    !!session.pullRequest &&
    cachedPullRequest(session.hostId, session.pullRequest)?.state === 'merged';
  const mergedCleanup = {
    candidates: mergedCleanupCandidates(
      store.sessions,
      hostId => supportsMergedCleanup(hostId) && store.hostReady(hostId),
    ),
    read: (session: Session) =>
      desktopApi(session.hostId).readMergedWorktreeCleanup({
        sessionId: session.id,
      }),
    finish: (session: Session) =>
      desktopApi(session.hostId).finishMergedWorktree({
        sessionId: session.id,
        revision: latestSession(session).revision,
      }),
  };
  const openResume = (session: Session) => {
    setResumeError('');
    setResumeTarget({ session, messageId: crypto.randomUUID() });
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
          canResume: supportsResume(session.hostId),
          busy: threadActionBusy(session),
          onResume: () => openResume(session),
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
      ...(offersFinishAfterMerge(session)
        ? [
            {
              label: 'Finish after merge…',
              icon: <GitMerge />,
              disabled: threadActionBusy(session),
              onSelect: () => setMergeTarget(session),
            },
          ]
        : []),
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
          {
            label: selected.reviewEveryResult
              ? 'Stop reviewing every result'
              : 'Review every result',
            icon: <ListChecks />,
            disabled:
              !store.hostReady(selectedHostId) ||
              selected.status === 'running' ||
              selected.status === 'stopping',
            onSelect: () =>
              void desktopApi(selectedHostId)
                .assignSessionWorkflow({
                  sessionId: selected.id,
                  reviewEveryResult: !selected.reviewEveryResult,
                })
                .then(session => store.merge([session]))
                .catch(error =>
                  setErrors(previous => ({
                    ...previous,
                    [selectedKey]: errorDetail(error),
                  })),
                ),
          },
          ...terminalAction(selected),
          exportAction(selected),
        ]
      : [];
  const finishWorktreeAvailable =
    !browsing &&
    !creating &&
    !!selected?.worktree &&
    !selected.worktree.workerTargetBranch &&
    !!window.nesvo;
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
    if (supportsMcp(session.hostId))
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
    if (!session) return [];
    const commands = sessionCommands(session);
    const host = store.computers.find(
      computer => computer.id === session.hostId,
    );
    if (
      !session.parentId &&
      !session.workflowRunId &&
      !session.workflowStepId &&
      !session.scheduledJobId &&
      !session.archivedAt &&
      !store.sessions.some(
        child =>
          child.hostId === session.hostId && child.parentId === session.id,
      ) &&
      host?.capabilities.includes('coordinator-orchestration') &&
      store.hostReady(session.hostId)
    ) {
      commands.push({
        id: 'enable-coordinator-wake',
        label: 'Resume when children finish',
        icon: <FolderOpen />,
        run: () => {
          void (async () => {
            const target = { sessionId: session.id };
            const state = await window.nesvo.readCoordinatorWake(
              target,
              session.hostId,
            );
            if (!state.enabled)
              await window.nesvo.setCoordinatorWake(
                {
                  ...target,
                  enabled: true,
                  actionId: crypto.randomUUID(),
                  expectedRevision: state.revision,
                },
                session.hostId,
              );
          })().catch(error =>
            setErrors(previous => ({
              ...previous,
              [entityKey(session)]: errorDetail(error),
            })),
          );
        },
      });
    }
    return commands;
  };
  const forkSource = !browsing && !creating ? selected?.forkOf : null;
  const runningApps = useRunningApps(
    store.computers,
    store.sessions,
    runningAppsEnabled &&
      ((sidebarOpen && viewportWidth >= 768) || navigationOpen),
    runningAppsEnabled && !browsing && !creating ? (selected ?? null) : null,
  );
  const readableMessageSession =
    selected && store.hostReady(selectedHostId) ? selected.id : null;
  const checkMessageFile = useMemo(() => {
    const directories = new Map<string, Promise<Set<string>>>();
    return async (path: string) => {
      if (!readableMessageSession) return false;
      const directory = path.slice(0, Math.max(0, path.lastIndexOf('/')));
      let entries = directories.get(directory);
      if (!entries) {
        if (directories.size >= 64) return false;
        entries = desktopApi(selectedHostId)
          .listWorkspaceDirectory({
            sessionId: readableMessageSession,
            path: directory,
          })
          .then(
            result =>
              new Set(
                result.entries
                  .filter(entry => entry.kind === 'file')
                  .map(entry => entry.path),
              ),
            () => {
              directories.delete(directory);
              return new Set<string>();
            },
          );
        directories.set(directory, entries);
      }
      return (await entries).has(path);
    };
  }, [readableMessageSession, selectedHostId]);
  const selectedApps = selected
    ? (runningApps.get(entityKey(selected)) ?? [])
    : [];
  const portOwner = (id: string) => {
    const session = hostSessions.find(item => item.id === id);
    if (!session) return 'Session';
    const role =
      session.role === 'worker'
        ? 'Worker'
        : session.parentId
          ? 'Child session'
          : 'Session';
    return role + ' · ' + session.title;
  };
  const sidebarProps = {
    runningApps,
    profilesFor,
    accountLabel,
    threadActions,
    deleteAction,
    housekeeping,
    onCleanUp: cleanupAvailable ? openCleanup : undefined,
    resumableCount: bulkResumeCandidates.filter(
      candidate => !candidate.restartOnly,
    ).length,
    onResumeSessions: () => {
      setNavigationOpen(false);
      setBulkResumeOpen(true);
    },
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
      store.reviews.filter(
        review =>
          review.status === 'pending' && routesToInbox(review.route ?? 'inbox'),
      ).length +
      inboxGateRules.rows.filter(
        ({ proposal }) => proposal.status === 'pending',
      ).length +
      inboxRules.items.filter(
        item => item.status === 'pending' && routesToInbox(item.route),
      ).length +
      automations.jobs.filter(job => job.pendingStart).length +
      store.sessions.reduce((count, session) => {
        const question = pendingTurnQuestion(session);
        const route = routeOf(session);
        const holdsOperation = inboxRules.items.some(
          item =>
            item.status === 'pending' &&
            item.binding === 'provider' &&
            item.sessionId === session.id &&
            item.hostId === session.hostId,
        );
        return (
          count +
          Number(!!session.parentRequest) +
          Number(!!session.coordinatorWait) +
          Number(!!question && routesToInbox(question.route)) +
          Number(
            !!pendingStageQuestion(session) &&
              routesToInbox(session.questionRouteOverride ?? route),
          ) +
          Number(
            session.plan?.status === 'plan-ready' && routesToInbox(route),
          ) +
          (session.status === 'running' &&
          session.runId &&
          routesToInbox(route) &&
          !holdsOperation
            ? session.pendingApprovals.length +
              session.delegations.filter(
                item =>
                  item.runId === session.runId && item.status === 'pending',
              ).length
            : 0)
        );
      }, 0),
    selectedId:
      creating || costsView || workflowsView || pullRequestsView || automation
        ? ''
        : selectedKey,
    unreadKeys,
    reviewKeys: new Set(
      store.reviews.flatMap(review =>
        review.status === 'pending'
          ? [hostKey(review.sessionId, review.hostId)]
          : [],
      ),
    ),
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
  const sessionPullRequest =
    sessionPanels && selected?.pullRequest
      ? { hostId: selected.hostId, reference: selected.pullRequest }
      : null;
  const reviewingSessionPullRequest =
    !!sessionPullRequest &&
    panel === 'pull-request' &&
    pullRequestLayout === 'session' &&
    !pullRequestsView &&
    pullRequestTarget?.hostId === sessionPullRequest.hostId &&
    sameReference(pullRequestTarget.reference, sessionPullRequest.reference);
  const reviewSessionPullRequest = sessionPullRequest
    ? () => reviewPullRequest(sessionPullRequest)
    : undefined;
  const openSkills = () => {
    diffTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPanel('skills');
  };
  const toggleHeaderPanel = (
    kind: 'terminal' | 'context',
    trigger: HTMLElement | null,
  ) => {
    if (panel === kind) {
      closeDiff();
      return;
    }
    diffTrigger.current = trigger;
    setPanel(kind);
  };
  const headerMenuActions: RowAction[] = compactSessionHeader
    ? [
        ...(!cardRun
          ? [
              {
                label: 'Session details',
                icon: <Gauge />,
                onSelect: () => {
                  const trigger = headerActionsTrigger.current;
                  if (trigger) toggleCard(trigger);
                },
              },
            ]
          : []),
        {
          label: 'Open skills',
          icon: <BookOpen />,
          onSelect: () => {
            openSkills();
            diffTrigger.current = headerActionsTrigger.current;
          },
        },
        ...(supportsSessionChanges(selectedHostId)
          ? [
              {
                label: 'Open changes',
                icon: <GitCompareArrows />,
                onSelect: () => {
                  openChanges();
                  diffTrigger.current = headerActionsTrigger.current;
                },
              },
            ]
          : []),
        ...(selected?.provider === 'Claude Code'
          ? [
              {
                label: 'Open Claude terminal',
                icon: <SquareTerminal />,
                onSelect: () =>
                  toggleHeaderPanel('terminal', headerActionsTrigger.current),
              },
            ]
          : []),
        {
          label: 'Open context',
          icon: <PanelRight />,
          onSelect: () =>
            toggleHeaderPanel('context', headerActionsTrigger.current),
        },
        ...(headerActions.length ? ['separator' as const] : []),
        ...headerActions,
      ]
    : headerActions;
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
    reviewPullRequest: () => {
      if (reviewingSessionPullRequest) closeDiff();
      else reviewSessionPullRequest?.();
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
      flows: openFlows,
      automations:
        automationComputers.length > 0 ? () => openAutomations() : undefined,
      pullRequests: pullRequestsAvailable ? openPullRequests : undefined,
      costs: window.nesvo ? openCosts : undefined,
      settings: () => setSettingsPage('general'),
      detectSetup: () => setSettingsPage('your-setup'),
      shortcuts: () => setSettingsPage('shortcuts'),
      gettingStarted: () => guardEditor(onOpenOnboarding),
      toggleSidebar: isWide() ? () => toggleSidebar(!sidebarOpen) : undefined,
      files: sessionPanels ? openFiles : undefined,
      diff:
        sessionPanels && latestReview
          ? () => openDiff(latestReview.id)
          : undefined,
      skills: sessionPanels ? openSkills : undefined,
      reviewPullRequest: reviewSessionPullRequest,
      searchHistory: () => openHistorySearch(),
      cleanUp: cleanupAvailable ? openCleanup : undefined,
      resumeSessions: bulkResumeCandidates.length
        ? () => setBulkResumeOpen(true)
        : undefined,
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
  const setupComputer = store.computers.find(
    computer => computer.id === breadcrumbHostId,
  );
  const setupDrift = useSetupDrift(
    setupComputer,
    settingsPage !== 'your-setup',
  );
  const setupChangedHere =
    changedSetupHosts.includes(breadcrumbHostId) || setupDrift.count > 0;
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
  const workspace = (
    <div
      className={cn(
        'relative flex h-dvh min-h-0 overflow-hidden bg-background',
        sidebar.moving &&
          '[transition-property:--sidebar-extent] duration-slow ease-out',
      )}
      onTransitionEnd={settleSidebar}
      style={
        {
          '--sidebar-extent': sidebarOpen ? `${visibleSidebarWidth}px` : '0px',
        } as CSSProperties
      }
    >
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
      {resumeTarget && (
        <ResumeSessionDialog
          key={`${entityKey(resumeTarget.session)}/${resumeTarget.messageId}`}
          session={resumeTarget.session}
          error={resumeError}
          onResume={(text, skill) =>
            resumeSession(
              store.sessions.find(
                session =>
                  entityKey(session) === entityKey(resumeTarget.session),
              ) ?? resumeTarget.session,
              resumeTarget.messageId,
              text,
              skill,
            )
          }
          onRestart={() => {
            const target = resumeTarget.session;
            setResumeTarget(null);
            setRestartError('');
            setRestartTarget(target);
          }}
          onClose={() => setResumeTarget(null)}
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
      <ResumeSessionsDialog
        open={bulkResumeOpen}
        onOpenChange={setBulkResumeOpen}
        candidates={bulkResumeCandidates}
        computers={store.computers}
        resume={resumeFromList}
      />
      <SessionCleanup
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        sessions={store.sessions}
        computers={store.computers}
        busyKeys={cleanupBusyKeys}
        isEligibleHost={hostId =>
          housekeeping.supports(hostId) && store.hostReady(hostId)
        }
        setArchived={housekeeping.setArchived}
        merged={mergedCleanup.candidates.length > 0 ? mergedCleanup : undefined}
      />
      {mergeTarget && (
        <FinishAfterMergeDialog
          key={entityKey(mergeTarget)}
          session={latestSession(mergeTarget)}
          api={desktopApi(mergeTarget.hostId)}
          onClose={() => setMergeTarget(null)}
        />
      )}
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
        className={cn(
          'relative hidden w-(--sidebar-extent) shrink-0 bg-sidebar',
          sidebarShown && 'md:block',
        )}
      >
        {sidebarShown && (
          <>
            <div className="h-full overflow-hidden" inert={!sidebarOpen}>
              <div
                className="h-full"
                style={{ width: visibleSidebarWidth - 1 }}
              >
                <SessionSidebar
                  {...sidebarProps}
                  navigation="rail"
                  readBranch={readBranch}
                />
              </div>
            </div>
            <Separator
              orientation="vertical"
              className="absolute inset-y-0 right-0 bg-sidebar-border"
            />
            {sidebarOpen && (
              <SidebarResizer
                width={visibleSidebarWidth}
                onResize={width =>
                  setSidebarWidth(clampSidebarWidth(width, viewportWidth))
                }
              />
            )}
          </>
        )}
      </aside>
      <div className="pointer-events-none absolute top-0 left-(--rail-width) hidden h-(--shell-topbar-height) items-center pl-(--shell-brand-start) select-none md:flex">
        <BrandWordmark />
      </div>
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background',
          pullRequestsView &&
            visiblePanel === 'pull-request' &&
            'min-[1200px]:max-[1440px]:hidden',
        )}
      >
        <header
          ref={headerRef}
          className={cn(
            'drag-region flex h-(--shell-topbar-height) shrink-0 items-center gap-1.5 pr-[calc(var(--shell-gutter)+var(--titlebar-inset-right))] pl-[calc(0.5rem+var(--titlebar-inset-left))] md:pl-[max(0.5rem,calc(var(--shell-brand-end)-var(--sidebar-extent)))]',
            visiblePanel &&
              'min-[1200px]:gap-0.5 min-[1200px]:pr-(--shell-gutter)',
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
            <LeftSheetContent className="w-72">
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>Sessions and inbox.</SheetDescription>
              </SheetHeader>
              <SessionSidebar {...sidebarProps} />
            </LeftSheetContent>
          </Sheet>
          {parentSession && !browsing && !creating && (
            <IconButton
              size={32}
              label="Back to parent session"
              onClick={() => select(entityKey(parentSession))}
            >
              <ArrowLeft />
            </IconButton>
          )}
          <nav
            aria-label="Breadcrumb"
            className={cn(
              '@container/breadcrumb flex-1 px-1',
              panelBesideSession ? 'min-w-48' : 'min-w-24',
            )}
          >
            <ol className="flex min-w-0 items-center gap-2 text-ui">
              {creating && branch && (
                <li className="min-w-0 shrink-0">
                  <BranchChip branch={branch} worktree={headerWorktree} />
                </li>
              )}
              {breadcrumbDirectory !== null && !creating && (
                <>
                  <li
                    className={cn(
                      'hidden min-w-0 max-w-[min(20rem,50%)] shrink-0 items-center gap-1.5 text-muted-foreground',
                      panelBesideSession
                        ? '@min-[28rem]/breadcrumb:flex'
                        : '@min-[10rem]/breadcrumb:flex',
                    )}
                  >
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
                    {sessionPanels && selected && (
                      <RunningAppsChip
                        apps={selectedApps}
                        owner={portOwner}
                        local={selected.hostId === 'local'}
                      />
                    )}
                  </li>
                  <li
                    aria-hidden="true"
                    className={cn(
                      'hidden text-muted-foreground/60',
                      panelBesideSession
                        ? '@min-[28rem]/breadcrumb:block'
                        : '@min-[10rem]/breadcrumb:block',
                    )}
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
              {workflowPage === 'flows' && (
                <>
                  <li>
                    <Button
                      type="button"
                      variant="ghost"
                      className="font-normal text-muted-foreground"
                      onClick={() => setWorkflowPage('workflows')}
                    >
                      Workflows
                    </Button>
                  </li>
                  <li aria-hidden="true" className="text-muted-foreground/60">
                    /
                  </li>
                </>
              )}
              <li
                aria-current="page"
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <h1
                  title={!browsing && !creating ? selected?.title : undefined}
                  className={cn(
                    'truncate text-ui font-semibold',
                    panelBesideSession ? 'min-w-[min(10rem,100%)]' : 'min-w-12',
                  )}
                >
                  {costsView
                    ? 'Costs'
                    : creating
                      ? creationGroupName
                        ? `New thread · ${creationGroupName}`
                        : 'New thread'
                      : workflowsView
                        ? workflowsEditor
                          ? `Graph editor · ${workflowsEditor.workflowName ?? 'New workflow'}`
                          : workflowPage === 'flows'
                            ? 'Flows'
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
                    className="min-w-0 shrink text-2xs text-muted-foreground"
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
                    <span className="hidden text-2xs text-muted-foreground @min-[14rem]/breadcrumb:inline">
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
                    reviewing={reviewingSessionPullRequest}
                    triggerSize={headerIconSize}
                    onOpen={reference =>
                      reviewingSessionPullRequest
                        ? closeDiff()
                        : reviewPullRequest({
                            hostId: selected.hostId,
                            reference,
                          })
                    }
                    onLinked={session => store.merge([session])}
                    onFinishAfterMerge={
                      offersFinishAfterMerge(selected)
                        ? () => setMergeTarget(selected)
                        : undefined
                    }
                  />
                )}
              </li>
            </ol>
          </nav>
          {!browsing && !creating && selectedAccount && (
            <Hint label={`Account: ${selectedAccount}`}>
              <Chip
                size="sm"
                interactive={false}
                className={cn('max-w-28', panelBesideSession && 'shrink')}
              >
                <span className="truncate">{selectedAccount}</span>
              </Chip>
            </Hint>
          )}
          {sessionPanels &&
            (selectedHostId !== 'local' ||
              !store.hostReady(selectedHostId)) && (
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
            (sessionAttention ||
              (selected.status !== 'ready' &&
                !showsRunStatus(selected, selectedRun))) && (
              <span
                className={cn(
                  'hidden shrink-0 text-2xs sm:inline',
                  sessionAttention
                    ? 'text-warning-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {sessionAttention || sessionStatusLabel(selected)}
              </span>
            )}
          {!browsing &&
            !creating &&
            !wakeControl.state?.pending &&
            selected?.coordinatorWait && (
              <CoordinatorWait
                key={selectedKey}
                session={selected}
                sessions={workers}
                enabled={
                  store.hostReady(selectedHostId) &&
                  !!selectedComputer?.capabilities.includes(
                    'coordinator-workers',
                  )
                }
                onContinue={() => continueCoordinator(selected)}
              />
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
                    : folderBusy || sending
                      ? 'Wait for active work in this folder to finish.'
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
          {headerMenuActions.length > 0 && (
            <RowActionsMenu
              headerSize={headerIconSize}
              label="Session actions"
              actions={headerMenuActions}
              triggerRef={headerActionsTrigger}
            />
          )}
          {cardRun ? (
            <WorkflowStatus
              run={cardRun}
              open={cardOpen}
              onToggle={toggleCard}
            />
          ) : (
            !compactSessionHeader && (
              <IconButton
                size={headerIconSize}
                label="Session details"
                pressed={cardOpen}
                aria-controls={cardOpen ? 'session-card' : undefined}
                data-session-card-trigger
                onClick={event => toggleCard(event.currentTarget)}
              >
                <Gauge />
              </IconButton>
            )
          )}
          {sessionPanels && !compactSessionHeader && (
            <IconButton
              size={headerIconSize}
              label="Open skills"
              pressed={panel === 'skills'}
              onClick={openSkills}
            >
              <BookOpen />
            </IconButton>
          )}
          {!browsing && !creating && selected && (
            <IconButton
              size={headerIconSize}
              label="Open files"
              shortcut={shortcutKeys('files')}
              pressed={panel === 'files'}
              onClick={openFiles}
            >
              <FolderOpen />
            </IconButton>
          )}
          {!browsing &&
            !creating &&
            selected &&
            !compactSessionHeader &&
            supportsSessionChanges(selectedHostId) && (
              <IconButton
                size={headerIconSize}
                label="Open changes"
                pressed={panel === 'changes'}
                onClick={openChanges}
              >
                <GitCompareArrows />
              </IconButton>
            )}
          {sessionPanels &&
            !compactSessionHeader &&
            selected?.provider === 'Claude Code' && (
              <IconButton
                size={headerIconSize}
                label="Open Claude terminal"
                pressed={panel === 'terminal'}
                onClick={event =>
                  toggleHeaderPanel('terminal', event.currentTarget)
                }
              >
                <SquareTerminal />
              </IconButton>
            )}
          {!browsing && !creating && selected && selectedReviews.length > 0 && (
            <SessionReviews
              key={selectedKey}
              {...reviewDecisionProps}
              open={resultsOpen}
              onOpenChange={open => {
                setResultsOpen(open);
                if (!open && sessionTarget.startsWith('review-'))
                  setSessionTarget('');
              }}
              triggerRef={resultsTrigger}
              triggerSize={headerIconSize}
              reviews={selectedReviews}
              allReviews={hostReviews}
              focusedId={
                sessionTarget.startsWith('review-')
                  ? sessionTarget.slice(7)
                  : ''
              }
              onSession={select}
              onOpenDiff={(reviewId, path) => {
                openDiff(reviewId, path);
                diffTrigger.current = resultsTrigger.current;
                setResultsOpen(false);
              }}
            />
          )}
          {sessionPanels && !compactSessionHeader && (
            <IconButton
              size={headerIconSize}
              label="Open context"
              ref={contextTrigger}
              pressed={panel === 'context'}
              onClick={event =>
                toggleHeaderPanel('context', event.currentTarget)
              }
            >
              <PanelRight />
            </IconButton>
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
        {setupChangedHere && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-2">
            <StatusMessage>
              Setup changed on {setupComputer?.name ?? 'this computer'}.
              {setupDrift.count > 0 &&
                ` ${setupDrift.count} ${setupDrift.count === 1 ? 'finding' : 'findings'} changed.`}
            </StatusMessage>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setupDrift.markViewed();
                setChangedSetupHosts(previous =>
                  previous.filter(hostId => hostId !== breadcrumbHostId),
                );
                setAccountSettingsHostId(breadcrumbHostId);
                setSettingsPage('your-setup');
              }}
            >
              Review setup changes
            </Button>
          </div>
        )}
        <main className="relative flex min-h-0 min-w-0 flex-1">
          {showingNewThread ? (
            <NewThread
              setup={threadSetup}
              onSetupChange={setThreadSetup}
              computers={store.computers}
              defaultFolders={defaultFolders.folders}
              statuses={store.providerStates(threadSetup.hostId)}
              profiles={profilesFor(threadSetup.hostId)}
              onRefreshProvider={provider =>
                void store.refreshProvider(provider, threadSetup.hostId)
              }
              onManageComputers={() => setSettingsPage('computers')}
              setupSummary={
                <NewSessionSetupFinding
                  computer={store.computers.find(
                    computer => computer.id === threadSetup.hostId,
                  )}
                  directory={threadSetup.directory.trim()}
                  onReview={() => {
                    setAccountSettingsHostId(threadSetup.hostId);
                    setSetupReviewDirectory(threadSetup.directory.trim());
                    setSettingsPage('your-setup');
                  }}
                />
              }
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
                onRefreshProvider={provider =>
                  void store.refreshProvider(provider, workflowsEditor.hostId)
                }
                onShare={workflowName =>
                  setShareTarget({
                    hostId: workflowsEditor.hostId,
                    directory: workflowsEditor.directory,
                    workflowName,
                  })
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
                      drawerHost={context.drawerHost}
                      open={context.open}
                      onDrawerOpenChange={context.onDrawerOpenChange}
                      hostId={workflowsEditor.hostId}
                      directory={workflowsEditor.directory}
                      context={{
                        view: 'editor',
                        workflowName: context.workflowName,
                        document: context.document,
                        selection: context.selection,
                        humanGate: context.humanGate,
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
          ) : workflowPage === 'flows' ? (
            <Suspense
              fallback={
                <StatusMessage tone="loading" className="p-6">
                  Loading flows…
                </StatusMessage>
              }
            >
              <WorkflowFlows
                computers={store.computers}
                sessions={store.sessions}
                runs={store.workflowRuns}
                steps={store.workflowSteps}
                wakeStates={flowWake}
                reviews={store.reviews}
                inboxItems={inboxRules.items}
                routeOf={routeOf}
                onSession={session => select(entityKey(session))}
                onDecisionSession={key => select(key)}
                onInbox={target => {
                  setInboxLink(target);
                  openInboxNow();
                }}
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
              <div
                ref={setAssistantDrawerHost}
                className="relative flex min-h-0 min-w-0 flex-1 overflow-x-clip"
              >
                <WorkflowDefinitions
                  computers={store.computers}
                  hostId={workflowsSource.hostId}
                  directory={workflowsSource.directory}
                  api={window.nesvo.workflows}
                  refreshToken={definitionsRefresh}
                  highlighted={listAssistantAdded}
                  onSourceChange={setWorkflowsSource}
                  onFlows={() => setWorkflowPage('flows')}
                  onEdit={target => {
                    setNewWorkflow(null);
                    setWorkflowsSource({
                      hostId: target.hostId,
                      directory: target.directory,
                    });
                    setWorkflowsEditor(target);
                  }}
                  onCreate={setNewWorkflow}
                  onShare={setShareTarget}
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
                  'max-[1440px]:hidden',
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
                onOpenCodeReviewSettings={() => setSettingsPage('code-review')}
              />
            </div>
          ) : costsView ? (
            <CostsView
              api={window.nesvo}
              computers={store.computers}
              sessions={store.sessions}
              initialHostId={selectedHostId}
              showBudgets={showBudgets}
              groupsByHost={store.groupLists}
              onSession={select}
            />
          ) : inbox ? (
            <ReviewInbox
              {...reviewDecisionProps}
              gateRules={inboxGateRules}
              linkedItem={inboxLink}
              ruleItems={inboxRules.items}
              rulePending={inboxRules.pending}
              ruleErrors={inboxRules.errors}
              onRuleDecision={(item, decision) =>
                void inboxRules.decide(item, decision)
              }
              onRuleOpenChanges={openRuleChanges}
              onRuleOpenPullRequest={openRulePullRequest}
              routeOf={routeOf}
              reviews={store.reviews}
              workflowRuns={store.workflowRuns}
              workflowSteps={store.workflowSteps}
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
              parentPending={parentPending}
              onContinueCoordinator={continueCoordinator}
              onDiff={openInboxDiff}
              onReply={replyToQuestion}
              stages={stages}
              onParent={(input, hostId) =>
                void decideSessionParent(input, hostId)
              }
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
                if (session && isAgentReviewSession(session))
                  return `Agent review · #${session.pullRequest?.number}`;
                return session && isAutomationSession(session)
                  ? name
                    ? `Automation · ${name}`
                    : 'Automation'
                  : '';
              }}
              lessons={
                <LessonInbox
                  computers={store.computers}
                  sessions={store.sessions}
                  api={window.nesvo}
                  onSession={select}
                />
              }
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
          ) : automationView ? (
            <div
              ref={setAssistantDrawerHost}
              className="relative flex min-h-0 min-w-0 flex-1 overflow-x-clip"
            >
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
                renderStageRecord={record => (
                  <StageRecord
                    session={selected}
                    record={record}
                    actions={stages}
                  />
                )}
                focusTarget={
                  sessionTarget.startsWith('review-') ? '' : sessionTarget
                }
                messageTarget={messageTarget}
                workers={workers}
                messageLinks={{
                  directory: selected.directory,
                  ports: new Set(selectedApps.map(app => app.port)),
                  hostId: selected.hostId,
                  hostName:
                    selectedComputer?.name ??
                    (selected.hostId === 'local' ? 'Local' : 'Remote computer'),
                  local: selected.hostId === 'local',
                  pullRequests: pullRequestApi(selected.hostId),
                  openPullRequest: reference =>
                    reviewPullRequest({ hostId: selected.hostId, reference }),
                  openFile: file => {
                    openFiles();
                    setFileLink({
                      ...file,
                      sessionKey: selectedKey,
                      request: crypto.randomUUID(),
                    });
                  },
                  fileExists: checkMessageFile,
                  internalLink: (kind, id, hostId = selected.hostId) => {
                    if (kind === 'session') {
                      const session = store.sessions.find(
                        item => item.id === id && item.hostId === hostId,
                      );
                      return session
                        ? {
                            label: session.title,
                            open: () => select(entityKey(session)),
                          }
                        : null;
                    }
                    const item = inboxRules.items.find(
                      item => item.id === id && item.hostId === hostId,
                    );
                    return item
                      ? {
                          label: item.subject,
                          open: () =>
                            guardEditor(() => {
                              setInboxLink({ hostId, id });
                              openInboxNow();
                            }),
                        }
                      : null;
                  },
                }}
                turnReviews={store.reviews.filter(
                  review =>
                    review.sessionId === selected.id &&
                    review.hostId === selected.hostId,
                )}
                onOpenTurnDiff={openDiff}
                onOpenChild={child => select(entityKey(child))}
                childReviewPending={child =>
                  orchestration &&
                  store.reviews.some(
                    review =>
                      review.hostId === child.hostId &&
                      review.sessionId === child.id &&
                      review.runId === child.runId &&
                      review.status === 'pending' &&
                      !!review.route &&
                      routesToParent(review.route),
                  )
                }
                coordinatorRecovery={!!wakeControl.state?.continueRequired}
                coordinationFooter={
                  wakeControl.state?.pending || wakeControl.state?.effective ? (
                    <CoordinatorWakeFooter
                      key={selectedKey}
                      session={selected}
                      children={coordinatorChildren}
                      control={wakeControl}
                    />
                  ) : undefined
                }
                onInspectChild={orchestration ? inspectChild : undefined}
                parentTitle={
                  selected.parentId
                    ? store.sessions.find(
                        parent =>
                          parent.id === selected.parentId &&
                          parent.hostId === selected.hostId,
                      )?.title
                    : undefined
                }
                steeringFeedback={
                  feedbackNotice?.key === selectedKey
                    ? feedbackNotice
                    : undefined
                }
                canSteer={
                  orchestration &&
                  !!selected.parentId &&
                  selected.provider === 'Codex' &&
                  selected.status === 'running' &&
                  !selected.pendingApprovals.length &&
                  !pendingModeOf(selected) &&
                  !modelSelections[selectedKey] &&
                  !selectedSkills[selectedKey] &&
                  !composerAttachments.items(selectedKey).length
                }
                activityBar={
                  subsessionActivity?.visible && (
                    <SubsessionBar
                      overview={subsessionActivity}
                      parentDirectory={selected.directory}
                      connected={store.hostReady(selectedHostId)}
                      onStopChild={child => void stop(child)}
                      onOpen={select}
                    />
                  )
                }
                preparation={
                  sessionRecipe.run ||
                  store.sessions.some(
                    child =>
                      child.parentId === selected.id &&
                      child.hostId === selected.hostId,
                  ) ||
                  inboxRules.items.some(
                    item =>
                      item.status === 'pending' &&
                      item.parentId === selected.id &&
                      item.hostId === selected.hostId,
                  ) ? (
                    <>
                      {sessionRecipe.run && (
                        <WorktreeRecipeCard
                          {...sessionRecipe}
                          run={sessionRecipe.run}
                          enabled={store.hostReady(selectedHostId)}
                        />
                      )}
                      <ChildDecisions
                        parent={selected}
                        sessions={store.sessions}
                        items={inboxRules.items}
                        routeOf={routeOf}
                        reviews={store.reviews}
                        reviewDecisions={reviewDecisionProps}
                        onOpenDiff={openInboxDiff}
                        onReply={replyToQuestion}
                        enabled={
                          !store.loading &&
                          !store.error &&
                          store.hostReady(selectedHostId)
                        }
                        stages={parentStages}
                        rulePending={inboxRules.pending}
                        ruleErrors={inboxRules.errors}
                        onRuleDecision={(item, decision) =>
                          void inboxRules.decide(item, decision)
                        }
                        approvalPending={approvalPending}
                        onApproval={(input, hostId) =>
                          void respondApproval(input, hostId)
                        }
                        onOpen={select}
                        onOpenChanges={openRuleChanges}
                        onOpenPullRequest={openRulePullRequest}
                      />
                    </>
                  ) : undefined
                }
                delegations={
                  <Delegations
                    session={selected}
                    children={workers}
                    enabled={operationEnabled}
                    worktreeActions={selectedComputer?.capabilities.includes(
                      'coordinator-workers',
                    )}
                    pending={delegationPending}
                    restartEnabled={
                      operationEnabled &&
                      !!selectedComputer?.capabilities.includes(
                        'worker-restart',
                      )
                    }
                    restartPending={restartingWorkers}
                    restartError={
                      workerRestartErrors[entityKey(selected)] ?? ''
                    }
                    onContinueWorkers={targets =>
                      void continueWorkers(selected, targets)
                    }
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
                nativeCommands={
                  selected.provider === 'Claude Code' &&
                  !!selectedComputer?.capabilities.includes('claude-commands')
                }
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
                  !folderBusy &&
                  connection === 'ready' &&
                  selectedProviderState?.status?.status === 'ready' &&
                  !selectedProviderState.loading &&
                  !selectedProviderState.error
                }
                approvalsEnabled={operationEnabled}
                approvalPending={approvalPending}
                onApproval={input =>
                  selected.runId &&
                  void respondApproval(
                    { ...input, sessionId: selected.id, runId: selected.runId },
                    selectedHostId,
                  )
                }
                otherRunLabel={
                  blockingSession && isAutomationSession(blockingSession) ? (
                    automationBusy(blockingSession, selectedKey)
                  ) : (
                    <>
                      Waiting for{' '}
                      {directoryLabel(
                        selected.waitingFor?.directory ??
                          blockingSession?.directory ??
                          selected.directory,
                      )}
                      {blockingSession && (
                        <>
                          {' · '}
                          <Button
                            type="button"
                            variant="link"
                            size="inline"
                            onClick={() =>
                              goToSession(entityKey(blockingSession))
                            }
                          >
                            {blockingSession.title}
                          </Button>
                        </>
                      )}
                    </>
                  )
                }
                otherRun={
                  folderBusy &&
                  activeRun?.id !== selected.id &&
                  selected.status !== 'running' &&
                  selected.status !== 'stopping'
                }
                error={errors[selectedKey] ?? ''}
                onManageBudget={() => openCostsView(true)}
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
                  !!autonomy.data?.fullAccessEnabled &&
                    !selected.parentId &&
                    !selected.workflowRunId &&
                    !selected.scheduledJobId &&
                    selected.plan?.status !== 'planning' &&
                    selected.plan?.status !== 'plan-ready',
                )}
                pendingMode={pendingModeOf(selected)}
                onSelectMode={mode => {
                  if (mode === 'full-access') setFullAccessTarget(selected);
                  else
                    setModeSelections(previous => ({
                      ...previous,
                      [selectedKey]: mode,
                    }));
                }}
                canChangeMode={supportsModes(selectedHostId)}
                attachments={{
                  items: composerAttachments.items(selectedKey),
                  notice: composerAttachments.notice(selectedKey),
                  support: attachmentSupport({
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
                  onAdd: (files, offset, support) =>
                    composerAttachments.add(
                      selectedKey,
                      desktopApi(selectedHostId),
                      support,
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
                mcpNotice={
                  <>
                    {supportsMcpTrust && !isolatedMcp && (
                      <McpRepositoryNotice
                        configuration={mcpConfiguration}
                        onReview={() => setRepositoryReviewKey(selectedKey)}
                      />
                    )}
                    <SessionIngressItems
                      entries={externalEntries}
                      onOpen={id => {
                        if (selectedKey)
                          setExternalReceipt({ key: selectedKey, id });
                      }}
                    />
                  </>
                }
                mcpChip={
                  <McpChip
                    key={selectedKey}
                    configuration={mcpConfiguration}
                    connections={mcpConnections}
                    provider={selected.provider}
                    readOnly={
                      (pendingModeOf(selected) ?? selected.mode) === 'read-only'
                    }
                    isolated={isolatedMcp}
                    disabled={connection !== 'ready'}
                    unsupported={!supportsMcp(selectedHostId)}
                    supportsTrust={supportsMcpTrust}
                    readEnabledPlanHooks={
                      selected.provider === 'Claude Code' &&
                      selectedComputer?.capabilities.includes(
                        'readonly-integration-grants',
                      )
                        ? async () => {
                            const reply =
                              await window.nesvo.readonlyIntegrationGrants(
                                { action: 'read', sessionId: selected.id },
                                selected.hostId,
                              );
                            return reply.action === 'read'
                              ? reply.hooks.filter(hook => hook.enabled).length
                              : 0;
                          }
                        : undefined
                    }
                    onReadOnlySettings={
                      selectedComputer?.capabilities.includes(
                        'readonly-integration-grants',
                      )
                        ? () => {
                            setAccountSettingsHostId(selected.hostId);
                            setSettingsPage('permissions');
                          }
                        : undefined
                    }
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
          {selectedKey &&
            selectedKey === repositoryReviewKey &&
            !creating &&
            reviewRepository &&
            mcpConfiguration.showDecision && (
              <SidePanel
                kind="details"
                resizeLabel="Resize repository review"
                focusOnOpen
                onEscape={() => setRepositoryReviewKey(null)}
              >
                <SidePanelHeader
                  title="Review repository"
                  closeLabel="Close repository review"
                  onClose={() => setRepositoryReviewKey(null)}
                />
                <PanelBody className="overflow-y-auto p-3">
                  <RepositoryDecision
                    key={mcpConfiguration.decisionKey}
                    configuration={mcpConfiguration}
                    repository={reviewRepository}
                    onClose={() => setRepositoryReviewKey(null)}
                  />
                </PanelBody>
              </SidePanel>
            )}
          {selectedKey && externalReceipt?.key === selectedKey && !creating && (
            <SessionIngressDetails
              hostId={selectedHostId}
              entries={externalEntries}
              selectedId={externalReceipt.id}
              onOpen={id => setExternalReceipt({ key: selectedKey, id })}
              onClose={() => setExternalReceipt(null)}
            />
          )}
        </main>
      </div>
      {automationView === 'detail' && automationJob && !editor && (
        <AutomationDetail
          key={automation}
          job={automationJob}
          onClose={() => openAutomations()}
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
          onEdit={() => {
            if (automationJob.profileOwnership) {
              setAccountSettingsHostId(automationJob.hostId);
              setSettingsPage('your-setup');
            } else {
              openAutomationEditor(
                automationValues(automationJob),
                entityKey(automationJob),
              );
            }
          }}
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
      )}
      {cardOpen && (
        <SessionCard
          id="session-card"
          computer={selectedComputer}
          connection={connection}
          session={cardSession}
          run={cardRun}
          gitBranch={branch}
          pullRequest={
            cardSession?.pullRequest && (
              <PullRequestSection
                hostId={cardSession.hostId}
                reference={cardSession.pullRequest}
                api={pullRequestApi(cardSession.hostId)}
                unavailableReason={pullRequestBlockedReason(cardSession.hostId)}
                onReview={() => {
                  if (cardSession.pullRequest)
                    reviewPullRequest({
                      hostId: cardSession.hostId,
                      reference: cardSession.pullRequest,
                    });
                }}
              />
            )
          }
          onComputers={() => setSettingsPage('computers')}
          onFiles={openFiles}
          onPermissions={
            cardSession?.provider === 'Claude Code' &&
            supportsAutonomy(cardSession.hostId)
              ? () => {
                  diffTrigger.current = contextTrigger.current;
                  setPanel('context');
                }
              : undefined
          }
          changes={
            cardSession &&
            store.hostReady(cardSession.hostId) &&
            supportsSessionChanges(cardSession.hostId) && (
              <ChangesRow
                session={cardSession}
                api={desktopApi(cardSession.hostId)}
                onOpen={openChanges}
              />
            )
          }
          onRunWorkflow={() =>
            cardSession && void runAssignedWorkflow(cardSession)
          }
          onClose={closeCard}
          workflow={
            cardRun && (
              <WorkflowSection
                key={entityKey(cardRun)}
                run={cardRun}
                hostId={cardRun.hostId}
                gateRulesEnabled={store.computers.some(
                  computer =>
                    computer.id === cardRun.hostId &&
                    computer.capabilities.includes('gate-rules'),
                )}
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
              <SubsessionsSection
                entries={subsessions}
                parentDirectory={cardSession.directory}
                connected={store.hostReady(selectedHostId)}
                onSession={select}
                onStop={child => void stop(child)}
              />
            )
          }
          servers={
            cardSession &&
            selectedApps.length > 0 && (
              <RunningAppsSection
                apps={selectedApps}
                owner={portOwner}
                local={selectedHostId === 'local'}
              />
            )
          }
          usage={
            <UsageSection
              states={usage.states}
              connected={store.hostReady(selectedHostId)}
            />
          }
          coordination={
            orchestration &&
            coordinatorChildren.length > 0 && (
              <CoordinatorWakeSetting
                id="session-coordinator-wake"
                label="Resume when children finish"
                control={wakeControl}
              />
            )
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
      {panel === 'child-work' &&
        selected &&
        childWork &&
        inspectedChild &&
        childWork.coordinatorId === selected.id &&
        childWork.hostId === selected.hostId && (
          <ChildWorkDrawer
            key={entityKey(inspectedChild) + ':' + childWork.runId}
            coordinator={selected}
            child={inspectedChild}
            runId={childWork.runId}
            api={window.nesvo}
            connected={store.hostReady(childWork.hostId)}
            review={store.reviews.find(
              review =>
                review.hostId === childWork.hostId &&
                review.sessionId === childWork.childId &&
                review.runId === childWork.runId,
            )}
            onClose={closeDiff}
            onOpen={messageId => {
              selectNow(entityKey(inspectedChild));
              if (messageId) setMessageTarget({ id: messageId });
            }}
            onDiff={review => {
              selectNow(entityKey(inspectedChild));
              openDiff(review.id);
            }}
          />
        )}
      {panel === 'context' && !browsing && !creating && selected && (
        <SidePanel
          kind="context"
          resizeLabel="Resize context panel"
          role="dialog"
          aria-label="Context"
          focusOnOpen
          onEscape={closeDiff}
        >
          <SidePanelHeader
            title="Context"
            closeLabel="Close context"
            onClose={closeDiff}
          />
          <ScrollArea className="min-h-0 flex-1">
            <SessionDetails
              session={selected}
              permissions={
                selected.provider === 'Claude Code' &&
                autonomy.data && (
                  <PermissionRules
                    key={selectedKey}
                    rules={autonomy.data.rules.filter(rule => {
                      if (rule.scope === 'session')
                        return rule.sessionId === selected.id;
                      const folder = selected.directory.replaceAll('\\', '/');
                      const project = rule.directory
                        .replaceAll('\\', '/')
                        .replace(/\/$/, '');
                      return (
                        folder === project || folder.startsWith(project + '/')
                      );
                    })}
                    onRemove={async id => {
                      await autonomy.execute({
                        action: 'remove-rule',
                        id,
                      });
                    }}
                  />
                )
              }
            >
              <RunningAppsSection
                apps={selectedApps}
                owner={portOwner}
                local={selected.hostId === 'local'}
              />
              {selected.pullRequest && (
                <PullRequestCard
                  hostId={selectedHostId}
                  reference={selected.pullRequest}
                  api={pullRequestApi(selectedHostId)}
                  unavailableReason={pullRequestBlockedReason(selectedHostId)}
                  onReview={next =>
                    reviewPullRequest({
                      hostId: selectedHostId,
                      reference: next,
                    })
                  }
                  onOpen={next =>
                    openPullRequestSurface({
                      hostId: selectedHostId,
                      reference: next,
                    })
                  }
                />
              )}

              {sessionRecipe.run && (
                <WorktreeRecipeResources
                  run={sessionRecipe.run}
                  runningApps={selectedApps.filter(
                    app => app.sessionId === selected.id,
                  )}
                  local={selectedComputer?.kind === 'local'}
                />
              )}
            </SessionDetails>
          </ScrollArea>
        </SidePanel>
      )}
      {(panel === 'files' || panel === 'skills') &&
        !browsing &&
        !creating &&
        selected &&
        !store.hostReady(selectedHostId) && (
          <PanelPlaceholder
            onClose={closeDiff}
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
            <PanelPlaceholder
              onClose={closeDiff}
              kind="diff"
              icon={FileCode2}
              title="Saved diff"
            >
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
            agentComments={agentCommentsFor(
              store.sessions.find(
                session =>
                  session.id === diffReview.sessionId &&
                  session.hostId === diffReview.hostId,
              ) ?? null,
              true,
              () => undefined,
            )}
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
                onClose={closeDiff}
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
              key={
                fileLink?.sessionKey === selectedKey
                  ? fileLink.request
                  : selectedKey
              }
              initialFile={
                fileLink?.sessionKey === selectedKey ? fileLink : undefined
              }
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
                onClose={closeDiff}
                kind={
                  !pullRequestsView && pullRequestLayout === 'session'
                    ? 'pull-request-review'
                    : 'pull-request'
                }
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
              key={`${referenceKey(pullRequestTarget)}:${pullRequestsView ? 'surface' : pullRequestLayout}`}
              layout={pullRequestsView ? 'surface' : pullRequestLayout}
              onExpand={() => openPullRequestSurface(pullRequestTarget)}
              target={pullRequestTarget}
              api={desktopApi(pullRequestTarget.hostId)}
              blockedReason={pullRequestBlockedReason(pullRequestTarget.hostId)}
              reviewBlockedReason={agentReviewBlockedReason(
                pullRequestTarget.hostId,
              )}
              reviewDirectory={reviewDirectory}
              onOpenSession={sessionId =>
                select(hostKey(sessionId, pullRequestTarget.hostId))
              }
              onOpenCodeReviewSettings={() => setSettingsPage('code-review')}
              linkedSession={checkoutSession}
              sendTargetTitle={threadTarget?.title ?? ''}
              onSendToSession={sendToSession}
              agentComments={agentCommentsFor(
                threadTarget,
                !!(checkoutSession ?? linkedSessions[0]),
                target => {
                  const key = entityKey(target);
                  if (key !== selectedKey || browsing || creating) {
                    selectNow(key);
                    setPanel('pull-request');
                  }
                },
              )}
              onLinked={session => store.merge([session])}
              onClose={closeDiff}
            />
          </Suspense>
        )}
      {panel === 'terminal' &&
        !browsing &&
        !creating &&
        selected?.provider === 'Claude Code' && (
          <ClaudeTerminal
            key={selectedKey}
            session={selected}
            connected={store.hostReady(selectedHostId)}
            onClose={closeDiff}
          />
        )}
      {panel === 'changes' &&
        !browsing &&
        !creating &&
        selected &&
        store.hostReady(selectedHostId) &&
        supportsSessionChanges(selectedHostId) && (
          <Suspense
            fallback={
              <PanelPlaceholder
                onClose={closeDiff}
                kind="changes"
                icon={GitCompareArrows}
                title="Changes"
              >
                <StatusMessage tone="loading" className="p-3">
                  Loading changes…
                </StatusMessage>
              </PanelPlaceholder>
            }
          >
            <SessionChangesPanel
              key={selectedKey}
              session={selected}
              api={desktopApi(selectedHostId)}
              agentComments={agentCommentsFor(selected, true, () => undefined)}
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
                onClose={closeDiff}
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
      <ShareWorkflowDialog
        target={shareTarget}
        api={window.nesvo.sharing}
        onOpenChange={open => {
          if (!open) setShareTarget(null);
        }}
      />
      <ImportWorkflowDialog
        offer={importOffers[0] ?? null}
        folders={importFolders}
        api={window.nesvo.sharing}
        onClose={() => setImportOffers(current => current.slice(1))}
        onImported={imported => {
          setImportOffers(current => current.slice(1));
          setDefinitionsRefresh(version => version + 1);
          openWorkflowEditor(
            'local',
            imported.directory,
            imported.workflowName,
          );
        }}
      />
      {newWorkflow && (
        <NewWorkflowDialog
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
          reviewApi={desktopApi}
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
            if (navigationVersion.current !== editor.navigation) return;
            setEditor(null);
            openAutomations(entityKey(job));
          }}
          onClose={() => setEditor(null)}
        />
      )}
      {fullAccessTarget && (
        <FullAccessDialog
          directory={fullAccessTarget.directory}
          provider={fullAccessTarget.provider}
          onClose={() => setFullAccessTarget(null)}
          onConfirm={async () => {
            await window.nesvo.claudeAutonomy(
              {
                action: 'confirm-full-access',
                sessionId: fullAccessTarget.id,
                directory: fullAccessTarget.directory,
              },
              fullAccessTarget.hostId,
            );
            setModeSelections(previous => ({
              ...previous,
              [entityKey(fullAccessTarget)]: 'full-access',
            }));
          }}
        />
      )}
      {settingsPage && (
        <Settings
          page={settingsPage}
          onPageChange={page => {
            setAuthoritySettings(null);
            setEditProfileRouting(false);
            setSetupReviewDirectory(undefined);
            setSettingsPage(page);
          }}
          fallbackFocus={navigationToggle}
          onOpenChange={open => {
            if (!open) {
              setAuthoritySettings(null);
              setEditProfileRouting(false);
              setSetupReviewDirectory(undefined);
              setSettingsPage(null);
            }
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
                  defaultFolder={defaultFolders.folders[settingsHostId] ?? null}
                  defaultFolderSupported={defaultFolders.supported(
                    settingsHostId,
                  )}
                  onSaveDefaultFolder={directory =>
                    defaultFolders.save(settingsHostId, directory)
                  }
                />
              </div>
            ) : page === 'permissions' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <PermissionSettings
                  key={settingsHostId}
                  hostId={settingsHostId}
                  ready={supportsAutonomy(settingsHostId)}
                  onChange={() => {
                    if (selectedHostId === settingsHostId)
                      void autonomy
                        .execute({ action: 'read' })
                        .catch(() => undefined);
                  }}
                />
                <RepositoryTrustSettings
                  key={'trust:' + settingsHostId}
                  hostId={settingsHostId}
                  ready={
                    store.hostReady(settingsHostId) &&
                    !!settingsComputer?.capabilities.includes(
                      'repository-trust-rules',
                    )
                  }
                />
                <ProviderUsageGateSettings
                  key={'usage:' + settingsHostId}
                  hostId={settingsHostId}
                  onEditProfile={() => setSettingsPage('your-setup')}
                  ready={
                    store.hostReady(settingsHostId) &&
                    !!settingsComputer?.capabilities.includes(
                      'provider-usage-gates',
                    )
                  }
                  profiles={profilesFor(settingsHostId)}
                />
                <ReadonlyIntegrationsSettings
                  key={'integrations:' + settingsHostId}
                  hostId={settingsHostId}
                  ready={
                    store.hostReady(settingsHostId) &&
                    !!settingsComputer?.capabilities.includes(
                      'readonly-integration-grants',
                    )
                  }
                  sessions={store.sessions.filter(
                    session => session.hostId === settingsHostId,
                  )}
                />
              </div>
            ) : page === 'notifications' ? (
              <NotificationsSettings />
            ) : page === 'code-review' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <CodeReviewSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  statuses={store.providerStates(settingsHostId)}
                  onRefreshProvider={provider =>
                    void store.refreshProvider(provider, settingsHostId)
                  }
                  api={desktopApi(settingsHostId)}
                />
              </div>
            ) : page === 'sharing' ? (
              <SharingSettings api={window.nesvo.sharing} />
            ) : page === 'import' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <ManagerImportPicker
                  key={settingsHostId}
                  api={window.nesvo}
                  computer={settingsComputer}
                />
              </div>
            ) : page === 'data' ? (
              <DataSettings api={desktopApi()} computers={store.computers} />
            ) : page === 'about' ? (
              <AboutSettings
                api={desktopApi()}
                computers={store.computers}
                onOpenGettingStarted={() => {
                  setSettingsPage(null);
                  guardEditor(onOpenOnboarding);
                }}
              />
            ) : page === 'computers' ? (
              <ManageComputers
                key={
                  authoritySettings?.kind === 'computers'
                    ? authoritySettings.review.id
                    : 'computers'
                }
                review={
                  authoritySettings?.kind === 'computers'
                    ? authoritySettings
                    : undefined
                }
                computers={store.computers}
                defaultFolders={defaultFolders}
                api={desktopApi()}
                onBusyChange={onBusyChange}
              />
            ) : page === 'phone' ? (
              <MobileAccess
                key={
                  authoritySettings?.kind === 'phone-access'
                    ? authoritySettings.review.id
                    : 'phone'
                }
                review={
                  authoritySettings?.kind === 'phone-access'
                    ? authoritySettings
                    : undefined
                }
                api={desktopApi()}
              />
            ) : page === 'devices' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <ConfigurationDevicesSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}:${authoritySettings?.review.id ?? ''}`}
                  computer={settingsComputer}
                  review={
                    authoritySettings?.kind === 'devices' &&
                    authoritySettings.hostId === settingsHostId
                      ? authoritySettings
                      : undefined
                  }
                />
                <DevicesSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  api={desktopApi(settingsHostId)}
                />
              </div>
            ) : page === 'your-setup' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                {settingsComputer?.status === 'connected' &&
                !settingsComputer.capabilities.includes('setup-profile-v1') &&
                !settingsComputer.capabilities.includes(
                  'setup-detection-v1',
                ) ? (
                  <StatusMessage>
                    Update this Nesvo host to use Your setup.
                  </StatusMessage>
                ) : (
                  <>
                    <SetupProfileSettings
                      key={`profile:${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                      computer={settingsComputer}
                      initialEdit={editProfileRouting}
                      openHistory={() => {
                        setEditProfileRouting(false);
                        setSettingsPage('change-history');
                      }}
                    />
                    <SetupFindings
                      key={`detection:${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                      computer={settingsComputer}
                      statuses={store.providerStates(settingsHostId)}
                      directory={setupReviewDirectory}
                      openImport={() => setSettingsPage('import')}
                    />
                  </>
                )}
              </div>
            ) : page === 'change-history' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <ConfigurationHistorySettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  openSession={id => {
                    setSettingsPage(null);
                    select(hostKey(id, settingsHostId));
                  }}
                />
              </div>
            ) : page === 'worktree-recipes' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <WorktreeProviderSettings
                  key={'worktree-provider:' + settingsHostId}
                  hostId={settingsHostId}
                  ready={
                    store.hostReady(settingsHostId) &&
                    !!settingsComputer?.capabilities.includes(
                      'custom-worktree-providers',
                    )
                  }
                />
                <WorktreeRecipesSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  api={desktopApi(settingsHostId)}
                />
              </div>
            ) : page === 'repositories' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <TrackedRepositoriesSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  api={desktopApi(settingsHostId)}
                />
              </div>
            ) : page === 'inbox-rules' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <InboxRulesSettings
                  onViewProfile={() => setSettingsPage('your-setup')}
                  onEditProfile={() => {
                    setEditProfileRouting(true);
                    setSettingsPage('your-setup');
                  }}
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  statuses={store.providerStates(settingsHostId)}
                  onRefreshProvider={provider =>
                    void store.refreshProvider(provider, settingsHostId)
                  }
                  defaultFolder={defaultFolders.folders[settingsHostId] ?? null}
                  api={desktopApi(settingsHostId)}
                />
              </div>
            ) : page === 'session-control' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <SessionControlSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  api={desktopApi(settingsHostId)}
                />
                <ExternalSessionSettings
                  key={'external:' + settingsHostId}
                  hostId={settingsHostId}
                  ready={
                    store.hostReady(settingsHostId) &&
                    !!settingsComputer?.capabilities.includes(
                      'external-session-messages',
                    )
                  }
                  sessions={store.sessions.filter(
                    session =>
                      session.hostId === settingsHostId && !session.archivedAt,
                  )}
                />
                <SessionWatcherSettings
                  key={'watchers:' + settingsHostId}
                  hostId={settingsHostId}
                  ready={
                    store.hostReady(settingsHostId) &&
                    !!settingsComputer?.capabilities.includes(
                      'session-message-watchers',
                    )
                  }
                  defaultSession={store.sessions.find(
                    session =>
                      session.hostId === settingsHostId && !session.archivedAt,
                  )}
                />
              </div>
            ) : page === 'workflows' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <GateRuleSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                />
              </div>
            ) : page === 'lessons' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <LessonsSettings
                  onSession={session => {
                    setSettingsPage(null);
                    select(session);
                  }}
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  statuses={store.providerStates(settingsHostId)}
                  onRefreshProvider={provider =>
                    void store.refreshProvider(provider, settingsHostId)
                  }
                  api={desktopApi(settingsHostId)}
                />
              </div>
            ) : page === 'mcp' ? (
              <div className="space-y-4">
                {settingsComputerSelect}
                <McpSettings
                  key={`${settingsHostId}:${settingsComputer?.instanceId ?? ''}`}
                  computer={settingsComputer}
                  profiles={profileCatalog.catalogs[settingsHostId]?.profiles}
                />
                {settingsComputer?.capabilities.includes(
                  'readonly-integration-grants',
                ) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSettingsPage('permissions')}
                  >
                    Read-only integrations
                  </Button>
                )}
              </div>
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
  return (
    <AuthoritySettingsContext.Provider
      value={review =>
        guardEditor(() => {
          setAuthoritySettings(review);
          setAccountSettingsHostId(review.hostId);
          setSettingsPage(
            review.kind === 'phone-access' ? 'phone' : review.kind,
          );
        })
      }
    >
      {workspace}
    </AuthoritySettingsContext.Provider>
  );
}
