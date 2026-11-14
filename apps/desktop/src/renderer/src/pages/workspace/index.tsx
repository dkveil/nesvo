import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  CreateSessionInput,
  DecideDelegationInput,
  DecideReviewInput,
  DesktopReview as Review,
  DesktopSession as Session,
  RespondApprovalInput,
  StartPipelineTaskInput,
} from '@nesvo/contracts';
import {
  ArrowLeft,
  BookOpen,
  FolderOpen,
  Gauge,
  Menu,
  PanelLeft,
  PanelRight,
  Plus,
  SquareDashed,
} from 'lucide-react';
import {
  directoryLabel,
  errorDetail,
  providerStatusLabel,
  sessionRoleLabel,
  sessionStatusLabel,
} from '@/entities/session';
import { showsRunStatus } from '@/entities/pipeline';
import type { EditorTarget } from '@/widgets/pipeline-definitions';
import type { SkillSummary } from '@/widgets/pipeline-graph-editor/inspector';
import { NewThread, type ThreadSetup } from '@/features/new-thread';
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
import { Conversation } from '@/widgets/conversation';
import { Delegations } from '@/widgets/delegations';
import { PipelineStatus } from '@/widgets/pipeline-status';
import { ReviewInbox } from '@/widgets/review-inbox';
import { SessionDetails } from '@/widgets/session-details';
import { SessionActivity } from '@/widgets/session-activity';
import { SessionReviews } from '@/widgets/session-reviews';
import { SessionSidebar } from '@/widgets/session-sidebar';
import {
  PipelineSection,
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
import { cn } from 'cn';
import { desktopApi, useSessions } from './use-sessions';
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

const PipelineDefinitions = lazy(
  () => import('@/widgets/pipeline-definitions'),
);

const PipelineGraphEditor = lazy(
  () => import('@/widgets/pipeline-graph-editor'),
);

export function Workspace() {
  const store = useSessions();
  const [location] = useState(readWorkspaceLocation);
  const [selectedId, setSelectedId] = useState(location.selectedId);
  const [inbox, setInbox] = useState(location.inbox);
  const [sessionTarget, setSessionTarget] = useState('');
  const [panel, setPanel] = useState<'diff' | 'files' | 'skills' | null>(
    location.diff ? 'diff' : null,
  );
  const [pipelinesView, setPipelinesView] = useState(false);
  const [pipelinesSource, setPipelinesSource] = useState({
    hostId: 'local',
    directory: '',
  });
  const [pipelinesEditor, setPipelinesEditor] = useState<EditorTarget | null>(
    null,
  );
  const [editorDirty, setEditorDirty] = useState(false);
  const [leaveEditor, setLeaveEditor] = useState<(() => void) | null>(null);
  const browsing = inbox || pipelinesView;
  const editorHostId = pipelinesEditor?.hostId ?? '';
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
  const editorRun = pipelinesEditor?.pipelineName
    ? store.pipelineRuns
        .filter(
          run =>
            run.hostId === pipelinesEditor.hostId &&
            run.pipeline.name === pipelinesEditor.pipelineName &&
            (!pipelinesEditor.directory ||
              run.projectRoot === pipelinesEditor.directory ||
              run.directory === pipelinesEditor.directory),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    : undefined;
  const editorRunOverlay = editorRun
    ? {
        run: editorRun,
        steps: store.pipelineSteps.filter(
          step =>
            step.runId === editorRun.id && step.hostId === editorRun.hostId,
        ),
      }
    : undefined;
  const cardTrigger = useRef<HTMLElement | null>(null);
  const [pipelinePending, setPipelinePending] = useState<
    Record<string, boolean>
  >({});
  const [pipelineErrors, setPipelineErrors] = useState<Record<string, string>>(
    {},
  );
  const pipelineRequests = useRef(new Set<string>());
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
  const sidebarCollapseToggle = useRef<HTMLButtonElement | null>(null);
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedSkills, setSelectedSkills] = useState<
    Record<string, SelectedSkill | null>
  >({});
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
      { text: string; skillId?: string; skillHash?: string; messageId: string }
    >
  >({});
  const stopping = useRef(new Set<string>());
  const selected =
    store.sessions.find(session => entityKey(session) === selectedId) ??
    store.sessions[0];
  const selectedKey = selected ? entityKey(selected) : '';
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
  const selectedRun = selected?.pipelineRunId
    ? store.pipelineRuns.find(
        run =>
          run.id === selected.pipelineRunId && run.hostId === selectedHostId,
      )
    : undefined;
  const selectedRunSteps = selectedRun
    ? store.pipelineSteps.filter(
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
      diff: !inbox && panel === 'diff' && diffReview ? diffTarget : null,
    });
  }, [
    selectedKey,
    inbox,
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
    requestAnimationFrame(() => {
      const target = open
        ? sidebarCollapseToggle.current
        : sidebarToggle.current;
      target?.focus();
    });
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
      setPipelineErrors(previous => ({
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
    if (pipelinesView && pipelinesEditor && editorDirty)
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
    setPipelinesView(false);
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
    setPipelinesView(false);
    setNavigationOpen(false);
  };
  const openPipelines = () => guardEditor(openPipelinesNow);
  const openPipelinesNow = () => {
    navigationVersion.current += 1;
    setPipelinesSource(
      creating || !selected
        ? { hostId: threadSetup.hostId, directory: threadSetup.directory }
        : { hostId: selected.hostId, directory: selected.directory },
    );
    setPanel(null);
    setDiffTarget(null);
    setCreating(false);
    setInbox(false);
    setPipelinesEditor(null);
    setPipelinesView(true);
    setNavigationOpen(false);
  };
  const openCreate = () => guardEditor(openCreateNow);
  const openCreateNow = () => {
    navigationVersion.current += 1;
    setNavigationOpen(false);
    setDetailsOpen(false);
    setPanel(null);
    setDiffTarget(null);
    setInbox(false);
    setPipelinesView(false);
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
      prior.skillHash === skillHash
        ? prior
        : { text, skillId, skillHash, messageId: crypto.randomUUID() };
    sendAttempts.current[sessionKey] = attempt;
    sendingRef.current = true;
    setSending(true);
    setErrors(previous => ({ ...previous, [sessionKey]: '' }));
    const acknowledge = () => {
      delete sendAttempts.current[sessionKey];
      onAcknowledge();
    };
    try {
      const session = await desktopApi(hostId).sendMessage({
        sessionId,
        messageId: attempt.messageId,
        text,
        ...(skillId ? { skillId } : {}),
        ...(skillHash ? { skillHash } : {}),
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
        if (
          history
            .find(session => session.id === sessionId)
            ?.messages.some(message => message.id === attempt.messageId)
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
    if (
      !selected ||
      sendingRef.current ||
      activeRun ||
      connection !== 'ready' ||
      selectedProviderState?.status?.status !== 'ready' ||
      selectedProviderState.loading ||
      selectedProviderState.error
    )
      return;
    const sessionKey = entityKey(selected);
    const text = typed?.text ?? drafts[sessionKey]?.trim();
    if (!text || text.length > 32000) return;
    const version = draftVersions.current[sessionKey] ?? 0;
    const skill = typed?.skill ?? selectedSkills[sessionKey] ?? null;
    await deliver(selected, text, skill, () => {
      if ((draftVersions.current[sessionKey] ?? 0) === version) {
        setDrafts(previous => ({ ...previous, [sessionKey]: '' }));
        setSelectedSkills(previous => ({ ...previous, [sessionKey]: null }));
      }
    });
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
  const startPipelineTask = async (
    input: StartPipelineTaskInput,
  ): Promise<'opened' | 'started'> => {
    const hostId = threadSetup.hostId;
    if (threadRequest.current || sendingRef.current)
      throw new Error('Another thread is still starting.');
    if (!store.hostReady(hostId))
      throw new Error('Connect this computer before starting a task.');
    threadRequest.current = true;
    const origin = navigationVersion.current;
    let run: Awaited<ReturnType<typeof window.nesvo.pipelines.startTask>>;
    try {
      run = await window.nesvo.pipelines.startTask(hostId, input);
    } finally {
      threadRequest.current = false;
    }
    store.mergePipelineRuns([run]);
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
  const controlPipeline = async (
    action: 'stop' | 'resume' | 'confirm',
    stepId = '',
  ) => {
    if (!selectedRun || !store.hostReady(selectedRun.hostId)) return;
    const run = selectedRun;
    const key = entityKey(run);
    if (pipelineRequests.current.has(key)) return;
    pipelineRequests.current.add(key);
    setPipelinePending(previous => ({ ...previous, [key]: true }));
    setPipelineErrors(previous => ({ ...previous, [key]: '' }));
    try {
      store.mergePipelineRuns([
        action === 'stop'
          ? await window.nesvo.pipelines.stopRun(run.hostId, run.id)
          : action === 'resume'
            ? await window.nesvo.pipelines.resumeRun(run.hostId, run.id)
            : await window.nesvo.pipelines.skipStep(run.hostId, {
                runId: run.id,
                stepId,
                reason: 'The operator confirmed that the action already ran.',
              }),
      ]);
    } catch (failure) {
      setPipelineErrors(previous => ({
        ...previous,
        [key]: `Could not ${action === 'stop' ? 'stop the pipeline' : action === 'resume' ? 'resume the pipeline' : 'record the decision'}. ${errorDetail(failure)}`,
      }));
    } finally {
      pipelineRequests.current.delete(key);
      setPipelinePending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  const threadBusyReason =
    store.loading || store.error
      ? 'Session history is still loading.'
      : store.sessions.some(
            session =>
              session.hostId === threadSetup.hostId &&
              (session.status === 'running' || session.status === 'stopping'),
          )
        ? 'Another session is working on this computer.'
        : '';
  const stop = async () => {
    if (
      !selected?.runId ||
      !store.hostReady(selected.hostId) ||
      selected.status !== 'running' ||
      stopping.current.has(hostKey(selected.runId, selected.hostId))
    )
      return;
    const { id: sessionId, runId } = selected;
    const key = entityKey(selected);
    const runKey = hostKey(runId, selected.hostId);
    stopping.current.add(runKey);
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      store.merge([
        await desktopApi(selected.hostId).stopRun({ sessionId, runId }),
      ]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `Could not stop the run. ${errorDetail(failure)}`,
      }));
      try {
        await store.recover(selected.hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [key]: `${previous[key] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
        }));
      }
    } finally {
      stopping.current.delete(runKey);
    }
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
  const operationEnabled =
    connection === 'ready' && !store.loading && !store.error;
  const sidebarProps = {
    sessions: store.sessions,
    pipelineRuns: store.pipelineRuns,
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
    selectedId: creating || pipelinesView ? '' : selectedKey,
    inbox,
    pipelines: pipelinesView,
    onSelect: select,
    onInbox: openInbox,
    onPipelines: openPipelines,
    onCreate: openCreate,
  };
  const showingNewThread =
    creating || (!browsing && !selected && !store.loading && !store.error);
  const breadcrumbDirectory = showingNewThread
    ? threadSetup.directory.trim()
    : !browsing && selected
      ? selected.directory
      : null;
  const providerIssue =
    !browsing &&
    !creating &&
    selectedProviderState &&
    (selectedProviderState.error ||
      selectedProviderState.status?.status !== 'ready')
      ? selectedProviderState
      : null;
  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background">
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
                onCollapse={() => toggleSidebar(false)}
                collapseToggleRef={sidebarCollapseToggle}
                footerStart={
                  <ProviderUsage
                    key={`${selectedHostId}/footer`}
                    layout="row"
                    popoverSide="top"
                    {...usageProps}
                  />
                }
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
          <Button
            ref={sidebarToggle}
            type="button"
            variant="ghost"
            size="icon-sm"
            className={`size-7 text-muted-foreground ${sidebarOpen ? 'hidden' : 'hidden md:inline-flex'}`}
            aria-label="Toggle sidebar"
            aria-pressed={sidebarOpen}
            title="Expand sidebar (Ctrl+B)"
            onClick={() => toggleSidebar(true)}
          >
            <PanelLeft className="size-4" />
          </Button>
          {!sidebarOpen && (
            <span className="hidden pr-2 text-[13px] font-semibold tracking-tight select-none md:inline">
              Nesvo
            </span>
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
                    className="hidden max-w-48 shrink-0 items-center gap-1.5 text-muted-foreground sm:flex"
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
                  </li>
                  <li
                    aria-hidden="true"
                    className="hidden text-muted-foreground/60 sm:block"
                  >
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
                    : pipelinesView
                      ? pipelinesEditor
                        ? `Graph editor · ${pipelinesEditor.pipelineName ?? 'New pipeline'}`
                        : 'Pipelines'
                      : inbox
                        ? 'Inbox'
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
            <PipelineStatus
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
              onClose={closeCard}
              pipeline={
                cardRun && (
                  <PipelineSection
                    key={entityKey(cardRun)}
                    run={cardRun}
                    steps={selectedRunSteps}
                    connected={store.hostReady(selectedHostId)}
                    pending={!!pipelinePending[entityKey(cardRun)]}
                    error={pipelineErrors[entityKey(cardRun)] ?? ''}
                    api={window.nesvo.pipelines}
                    onStop={() => void controlPipeline('stop')}
                    onResume={() => void controlPipeline('resume')}
                    onConfirmAction={stepId =>
                      void controlPipeline('confirm', stepId)
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
              onStartPipeline={startPipelineTask}
            />
          ) : pipelinesView && pipelinesEditor ? (
            <Suspense
              fallback={
                <p role="status" className="p-6 text-xs text-muted-foreground">
                  Loading the graph editor…
                </p>
              }
            >
              <PipelineGraphEditor
                hostId={pipelinesEditor.hostId}
                directory={pipelinesEditor.directory}
                pipelineName={pipelinesEditor.pipelineName}
                catalog={pipelinesEditor.catalog}
                api={window.nesvo.pipelines}
                scheduledJobsApi={window.nesvo.scheduledJobs}
                computers={store.computers}
                statuses={store.providerStates(pipelinesEditor.hostId)}
                onClose={() => setPipelinesEditor(null)}
                onDirtyChange={setEditorDirty}
                onDiscoverSkills={discoverEditorSkills}
                runOverlay={editorRunOverlay}
                onInbox={openInbox}
                onSession={select}
              />
            </Suspense>
          ) : pipelinesView ? (
            <Suspense
              fallback={
                <p role="status" className="p-6 text-xs text-muted-foreground">
                  Loading pipelines…
                </p>
              }
            >
              <PipelineDefinitions
                computers={store.computers}
                hostId={pipelinesSource.hostId}
                directory={pipelinesSource.directory}
                api={window.nesvo.pipelines}
                onEdit={target => {
                  setPipelinesSource({
                    hostId: target.hostId,
                    directory: target.directory,
                  });
                  setPipelinesEditor(target);
                }}
              />
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
            />
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
          {(panel === 'files' || panel === 'skills') &&
            !browsing &&
            !creating &&
            selected &&
            !store.hostReady(selectedHostId) && (
              <aside className="absolute inset-0 z-10 flex flex-col gap-3 border-l bg-background p-5 text-sm min-[1200px]:relative min-[1200px]:w-96">
                <p>
                  This computer is offline. Current files and skills are
                  unavailable; saved conversations and result diffs remain
                  readable.
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
        </main>
      </div>
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
              The pipeline has unsaved changes. Leaving drops the edits made
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
