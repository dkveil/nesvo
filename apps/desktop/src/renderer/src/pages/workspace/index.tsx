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
  CreateSessionInput,
  DecideDelegationInput,
  DecideWorkerPlanInput,
  DecideReviewInput,
  DesktopReview as Review,
  DesktopSession as Session,
  RespondApprovalInput,
  SessionMode,
  StartWorkflowTaskInput,
} from '@nesvo/contracts';
import {
  ArrowLeft,
  BookOpen,
  FolderOpen,
  Gauge,
  Menu,
  PanelRight,
  Plus,
  SquareDashed,
} from 'lucide-react';
import {
  directoryLabel,
  errorDetail,
  providerModes,
  providerStatusLabel,
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
import { resolveGate } from '@/features/new-thread/workflow-choice';
import {
  AutomationEditor,
  automationValues,
  duplicateValues,
  newAutomationValues,
  type AutomationValues,
} from '@/features/edit-automation';
import { ManageComputers } from '@/features/manage-computers';
import { MobileAccess } from '@/features/mobile-access';
import { entityKey, hostKey } from '@/shared/lib/host-key';
import type { SelectedSkill } from '@/features/select-skill';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { BranchChip } from '@/features/git-branch/branch-chip';
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
import { Conversation, type ModelSelection } from '@/widgets/conversation';
import { Delegations } from '@/widgets/delegations';
import { WorkflowStatus } from '@/widgets/workflow-status';
import { ReviewInbox } from '@/widgets/review-inbox';
import { SessionDetails } from '@/widgets/session-details';
import { SessionActivity } from '@/widgets/session-activity';
import { SessionReviews } from '@/widgets/session-reviews';
import { NavigationRail } from '@/widgets/navigation-rail';
import { SessionSidebar } from '@/widgets/session-sidebar';
import { BrandWordmark } from '@/shared/ui/brand-wordmark';
import {
  WorkflowSection,
  SessionCard,
  UsageSection,
  WorkersSection,
} from '@/widgets/session-card';
import { ProviderAccounts, ProviderUsage } from '@/widgets/provider-rail';
import {
  AppearanceSettings,
  GeneralSettings,
  Settings,
  type SettingsPage,
} from '@/widgets/settings';
import { AutomationDetail, AutomationList } from '@/widgets/automations';
import type { ScheduledJob, ScheduledJobRun } from '@/entities/scheduled-job';
import { cn } from 'cn';
import { desktopApi, useSessions } from './use-sessions';
import { supportsScheduledJobs, useScheduledJobs } from './use-scheduled-jobs';
import { readDrafts, writeDrafts } from './draft-store';
import { SessionWorkflowChip } from '@/features/session-workflow';
import { readSeen, writeSeen } from './seen-store';
import { useAttention } from './use-attention';
import { useProviderUsage } from './use-provider-usage';
import { readWorkspaceLocation, saveWorkspaceLocation } from './location';
import { readSidebarOpen, saveSidebarOpen } from './sidebar-preference';
import { SidebarResizer } from './sidebar-resizer';
import {
  clampSidebarWidth,
  readSidebarWidth,
  saveSidebarWidth,
} from './sidebar-width';

const ReviewDiff = lazy(() => import('@/widgets/review-diff'));

const WorkspaceFiles = lazy(() => import('@/widgets/workspace-files'));

const SessionSkills = lazy(() => import('@/widgets/session-skills'));

const WorkflowDefinitions = lazy(
  () => import('@/widgets/workflow-definitions'),
);

const WorkflowAssistantDock = lazy(
  () => import('@/widgets/workflow-assistant'),
);

const WorkflowGraphEditor = lazy(
  () => import('@/widgets/workflow-graph-editor'),
);

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
  const [panel, setPanel] = useState<'diff' | 'files' | 'skills' | null>(
    location.diff ? 'diff' : null,
  );
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
          setAutomation('');
          setWorkflowsView(true);
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
          setAutomation('');
          setWorkflowsView(true);
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
  const browsing = inbox || workflowsView || !!automation;
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
  const threadRequest = useRef(false);
  const navigationVersion = useRef(0);
  const [threadSetup, setThreadSetup] = useState<ThreadSetup>({
    hostId: 'local',
    provider: 'Claude Code',
    model: 'default',
    effort: '',
    mode: 'read-only',
    directory: '',
  });
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
  const supportsModes = (hostId: string) =>
    !!store.computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('permission-modes');
  const pendingModeOf = (target: Session) =>
    supportsModes(target.hostId)
      ? (modeSelections[entityKey(target)] ?? null)
      : null;
  const [errors, setErrors] = useState<Record<string, string>>({});
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
        messageId: string;
      }
    >
  >({});
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
  const selectedRevision = selected?.revision ?? 0;
  const selectedVisible = !inbox && !creating && !workflowsView && !automation;
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
  const selectedComputer = store.computers.find(
    computer => computer.id === selectedHostId,
  );
  const usageTerminal =
    store.sessions
      .filter(session => session.hostId === selectedHostId)
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
  const selectedProviderState = selected
    ? store.providerStates(selectedHostId)[selected.provider]
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'b' ||
        !window.matchMedia('(min-width: 768px)').matches
      )
        return;
      event.preventDefault();
      toggleSidebar(!readSidebarOpen());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);
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
  const toggleCard = (trigger: HTMLElement) => {
    if (cardOpen) {
      closeCard();
      return;
    }
    cardTrigger.current = trigger;
    if (selectedRun)
      setWorkflowErrors(previous => ({
        ...previous,
        [entityKey(selectedRun)]: '',
      }));
    setCardOpen(true);
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
    setInbox(false);
    setWorkflowsView(false);
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
    setWorkflowsView(false);
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
    setWorkflowsEditor(null);
    setAutomation('');
    setWorkflowsView(true);
    setNavigationOpen(false);
  };
  const openAutomations = (target = 'list') =>
    guardEditor(() => openAutomationsNow(target));
  const openAutomationsNow = (target: string) => {
    navigationVersion.current += 1;
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(false);
    setWorkflowsEditor(null);
    setWorkflowsView(false);
    setAutomation(target);
    setNavigationOpen(false);
    setDetailsOpen(false);
  };
  const openCreate = () => guardEditor(openCreateNow);
  const openCreateNow = () => {
    navigationVersion.current += 1;
    setNavigationOpen(false);
    setDetailsOpen(false);
    setPanel(null);
    setDiffTarget(null);
    setInbox(false);
    setWorkflowsView(false);
    setAutomation('');
    setCreating(true);
  };
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
  ) => {
    const sessionId = target.id;
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
      prior.mode === mode
        ? prior
        : {
            text,
            skillId,
            skillHash,
            selection,
            mode,
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
    const text = typed?.text ?? drafts[sessionKey]?.trim();
    if (!text || text.length > 32000) return;
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
        if ((draftVersions.current[sessionKey] ?? 0) === version) {
          setDrafts(previous => ({ ...previous, [sessionKey]: '' }));
          setSelectedSkills(previous => ({ ...previous, [sessionKey]: null }));
        }
      },
      !!activeRun,
      selection,
      mode,
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
    try {
      const session = await desktopApi(hostId).createSession(input);
      store.merge([session]);
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
    if (
      !session ||
      session.runId !== input.runId ||
      session.status !== 'running' ||
      !store.hostReady(hostId) ||
      store.loading ||
      store.error ||
      !session.pendingApprovals.some(
        approval => approval.id === input.requestId,
      )
    )
      return;
    const { sessionId, runId, requestId } = input;
    const key = `${hostKey(sessionId, hostId)}/${runId}/${requestId}`;
    if (approvalRequests.current.has(key)) return;
    approvalRequests.current.add(key);
    setApprovalPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [hostKey(sessionId, hostId)]: '' }));
    try {
      store.merge([await desktopApi(hostId).respondApproval(input)]);
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
      <button
        type="button"
        className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        disabled={
          session.status !== 'running' || !store.hostReady(session.hostId)
        }
        onClick={() => void stopAutomation(session, reportKey)}
      >
        {session.status === 'stopping' ? 'Stopping…' : 'Stop'}
      </button>
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
  const sidebarProps = {
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
    selectedId: creating || workflowsView || automation ? '' : selectedKey,
    unreadKeys,
    inbox,
    workflows: workflowsView,
    onSelect: select,
    onInbox: openInbox,
    onWorkflows: openWorkflows,
    onCreate: openCreate,
    scheduledJobs: automations.jobs,
    automations: !!automation,
    automationsAvailable: automationComputers.length > 0,
    onAutomations: () => openAutomations(),
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
      ? selected.directory
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
              <Button
                ref={navigationToggle}
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open sessions"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 gap-0 p-0">
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
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to parent session"
              title={`Back to: ${parentSession.title}`}
              onClick={() => select(entityKey(parentSession))}
            >
              <ArrowLeft />
            </Button>
          )}
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1 px-1">
            <ol className="flex min-w-0 items-center gap-2 text-[13px]">
              {breadcrumbDirectory !== null && (
                <>
                  <li
                    className="hidden max-w-80 shrink-0 items-center gap-1.5 text-muted-foreground sm:flex"
                    title={breadcrumbDirectory || 'Isolated folder'}
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
                    <BranchChip
                      hostId={breadcrumbHostId}
                      directory={breadcrumbDirectory}
                      enabled={branchReadable}
                      api={desktopApi(breadcrumbHostId)}
                    />
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
                    <button
                      type="button"
                      className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openAutomations()}
                    >
                      Automations
                    </button>
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
                <h1 className="truncate text-[13px] font-semibold">
                  {creating
                    ? 'New thread'
                    : workflowsView
                      ? workflowsEditor
                        ? `Graph editor · ${workflowsEditor.workflowName ?? 'New workflow'}`
                        : 'Workflows'
                      : inbox
                        ? 'Inbox'
                        : automationView === 'detail'
                          ? automationJob?.name
                          : automationView === 'list'
                            ? 'Automations'
                            : (selected?.title ?? 'New thread')}
                </h1>
                {!browsing &&
                  !creating &&
                  selected &&
                  sessionRoleLabel(selected) && (
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">
                      {sessionRoleLabel(selected)}
                    </span>
                  )}
              </li>
            </ol>
          </nav>
          {!browsing && !creating && selected && (
            <span
              className="max-w-32 truncate text-[11px] text-muted-foreground"
              title={selectedComputer?.name}
            >
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
              <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                {sessionStatusLabel(selected)}
              </span>
            )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="New session"
            onClick={openCreate}
          >
            <Plus />
          </Button>
          {cardRun ? (
            <WorkflowStatus
              run={cardRun}
              open={cardOpen}
              onToggle={toggleCard}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground aria-pressed:bg-highlight aria-pressed:text-foreground"
              aria-label="Session details"
              title="Session details"
              aria-pressed={cardOpen}
              aria-controls={cardOpen ? 'session-card' : undefined}
              data-session-card-trigger
              onClick={event => toggleCard(event.currentTarget)}
            >
              <Gauge className="size-4" />
            </Button>
          )}
          {!browsing && !creating && selected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open skills"
              title="Shared library"
              aria-pressed={panel === 'skills'}
              onClick={() => {
                diffTrigger.current =
                  document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
                setCardOpen(false);
                setPanel('skills');
              }}
              className="text-muted-foreground aria-pressed:bg-highlight aria-pressed:text-foreground"
            >
              <BookOpen className="size-4" />
            </Button>
          )}
          {!browsing && !creating && selected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open files"
              title="Workspace files"
              aria-pressed={panel === 'files'}
              onClick={openFiles}
              className="text-muted-foreground aria-pressed:bg-highlight aria-pressed:text-foreground"
            >
              <FolderOpen className="size-4" />
            </Button>
          )}
          {!browsing && !creating && selected && (
            <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label="Open context"
                  title="Session context"
                >
                  <PanelRight className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent className="gap-0 bg-card">
                <SheetHeader className="border-b px-5 py-4">
                  <SheetTitle className="text-sm">Context</SheetTitle>
                  <SheetDescription className="text-xs">
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
            <p
              role="alert"
              className="min-w-0 text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
            >
              {store.error}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.location.reload()}
            >
              Reload window
            </Button>
          </div>
        )}
        {providerIssue && selected && (
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-2">
            <p
              role={providerIssue.error ? 'alert' : 'status'}
              className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
            >
              {providerIssue.error ||
                providerStatusLabel(selected.provider, providerIssue)}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs text-muted-foreground"
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
            />
          )}
          {showingNewThread ? (
            <NewThread
              setup={threadSetup}
              onSetupChange={setThreadSetup}
              computers={store.computers}
              statuses={store.providerStates(threadSetup.hostId)}
              onRefreshProvider={provider =>
                void store.refreshProvider(provider, threadSetup.hostId)
              }
              onManageComputers={() => setSettingsPage('computers')}
              busyReason={threadBusyReason}
              hostApi={desktopApi(threadSetup.hostId)}
              onStart={startThread}
              onStartWorkflow={startWorkflowTask}
            />
          ) : workflowsView && workflowsEditor ? (
            <Suspense
              fallback={
                <p role="status" className="p-6 text-xs text-muted-foreground">
                  Loading the graph editor…
                </p>
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
                <p role="status" className="p-6 text-xs text-muted-foreground">
                  Loading workflows…
                </p>
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
          ) : inbox ? (
            <ReviewInbox
              {...reviewDecisionProps}
              reviews={store.reviews}
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
                <p
                  key={entityKey(session)}
                  role="status"
                  className="mb-3 px-3 text-2xs text-muted-foreground"
                >
                  {automationBusy(session)}
                  {automationErrors[automationErrorKey(session)] && (
                    <span role="alert" className="block text-destructive">
                      {automationErrors[automationErrorKey(session)]}
                    </span>
                  )}
                </p>
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
              className={`flex min-h-0 min-w-0 flex-1 ${visiblePanel ? 'max-[1200px]:hidden' : ''}`}
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
                computerName={selectedComputer?.name ?? selectedHostId}
                onSkillChange={skill => changeSkill(selectedKey, skill)}
                sending={sending}
                canSend={
                  !sending &&
                  !activeRun &&
                  connection === 'ready' &&
                  selectedProviderState?.status?.status === 'ready' &&
                  !selectedProviderState.loading &&
                  !selectedProviderState.error
                }
                approvalsEnabled={operationEnabled}
                approvalPending={approvalPending}
                onApproval={(requestId, decision) =>
                  selected.runId &&
                  void respondApproval(
                    {
                      sessionId: selected.id,
                      runId: selected.runId,
                      requestId,
                      decision,
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
                  !sending && connection === 'ready' && !selected.workflowStepId
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
                statuses={store.providerStates(selectedHostId)}
                onRefreshProvider={provider =>
                  void store.refreshProvider(provider, selectedHostId)
                }
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
              />
            </div>
          ) : (
            <section
              className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center"
              aria-label="Sessions"
            >
              <h2 className="text-2xl font-medium tracking-tight">
                {store.loading ? 'Loading sessions…' : 'History is unavailable'}
              </h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                {store.loading
                  ? 'Loading your local history.'
                  : 'Reconnect to load your saved sessions.'}
              </p>
            </section>
          )}
        </main>
      </div>
      {(panel === 'files' || panel === 'skills') &&
        !browsing &&
        !creating &&
        selected &&
        !store.hostReady(selectedHostId) && (
          <aside className="absolute inset-0 z-10 flex flex-col gap-3 border-l bg-background p-5 text-sm min-[1200px]:relative min-[1200px]:w-96">
            <p>
              This computer is offline. Current files and skills are
              unavailable; saved conversations and result diffs remain readable.
            </p>
            <Button variant="outline" onClick={closeDiff}>
              Close panel
            </Button>
          </aside>
        )}
      {panel === 'diff' && !creating && diffReview && diffTarget && (
        <Suspense
          fallback={
            <aside
              role="status"
              className="absolute inset-0 z-10 border-l bg-background p-4 text-xs text-muted-foreground min-[1200px]:relative min-[1200px]:w-[46%]"
            >
              Loading saved diff…
            </aside>
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
              <aside
                role="status"
                className="absolute inset-0 z-10 border-l bg-background p-4 text-xs text-muted-foreground min-[1200px]:relative min-[1200px]:w-[56%]"
              >
                Loading files…
              </aside>
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
      {panel === 'skills' &&
        !browsing &&
        !creating &&
        selected &&
        store.hostReady(selectedHostId) && (
          <Suspense
            fallback={
              <aside
                role="status"
                className="absolute inset-0 z-10 border-l bg-background p-4 text-xs text-muted-foreground min-[1200px]:relative min-[1200px]:w-[380px]"
              >
                Loading skills…
              </aside>
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
            ) : page === 'computers' ? (
              <ManageComputers
                computers={store.computers}
                api={desktopApi()}
                onBusyChange={onBusyChange}
              />
            ) : page === 'phone' ? (
              <MobileAccess api={desktopApi()} />
            ) : (
              <ProviderAccounts
                {...usageProps}
                className="rounded-lg border bg-card px-4 pt-3 pb-4"
              />
            )
          }
        </Settings>
      )}
      <Dialog
        open={leaveEditor !== null}
        onOpenChange={open => {
          if (!open) setLeaveEditor(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">
              Leave the graph editor?
            </DialogTitle>
            <DialogDescription className="text-xs">
              The workflow has unsaved changes. Leaving drops the edits made
              since the last save.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLeaveEditor(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                const proceed = leaveEditor;
                setLeaveEditor(null);
                setEditorDirty(false);
                proceed?.();
              }}
            >
              Discard and leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
