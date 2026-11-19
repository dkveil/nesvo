import '@xyflow/react/dist/base.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type {
  Computer,
  DefinitionCatalog,
  DesktopApi,
  WorkflowAssistantDocument,
  ScheduledJob,
  StartWorkflowTaskInput,
} from '@nesvo/contracts';
import {
  latestAttempts,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '@/entities/workflow';
import type { Provider, ProviderStates } from '@/entities/session';
import { toFileText } from '@/entities/workflow-graph';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import type { InboxTarget } from '@/widgets/workflow-step-result';
import { EditorCanvas } from './canvas';
import { ConflictDialog } from './conflict-dialog';
import { InspectorPanel } from './inspector-panel';
import { IssuesStrip } from './issues-strip';
import { NodePicker, type AddRequest } from './node-picker';
import type { RunBadge } from './nodes';
import { Toolbar } from './toolbar';
import {
  useEditorState,
  type AddOrigin,
  type EditorDraftFields,
} from './use-editor-state';

type Props = {
  hostId: string;
  directory: string;
  workflowName: string | null;
  catalog: DefinitionCatalog;
  draft?: EditorDraftFields;
  api: DesktopApi['workflows'];
  scheduledJobsApi: DesktopApi['scheduledJobs'];
  computers: Computer[];
  statuses: ProviderStates;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onRefreshProvider?: (provider: Provider) => void;
  onRun?: (input: StartWorkflowTaskInput) => Promise<void>;
  onShare?: (workflowName: string) => void;
  runOverlay?: { run: WorkflowRun; steps: WorkflowStepRecord[] };
  onInbox?: (target: InboxTarget) => void;
  onSession?: (key: string) => void;
  assistantAdded?: string[];
  dock?: (context: EditorDockContext) => ReactNode;
};

export type EditorDockContext = {
  workflowName: string | null;
  document: WorkflowAssistantDocument | null;
  selection: string[];
  onApplied: () => void;
  onFocusStep: (name: string) => void;
};

function EditorDock({
  render,
  ...context
}: EditorDockContext & { render: (context: EditorDockContext) => ReactNode }) {
  return render(context);
}

const isTextTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.closest('input, textarea, select, [contenteditable="true"]') !==
    null ||
    target.closest('[role="dialog"]') !== null);

export default function WorkflowGraphEditor({
  hostId,
  directory,
  workflowName,
  catalog,
  draft,
  api,
  scheduledJobsApi,
  computers,
  statuses,
  onClose,
  onDirtyChange,
  onRefreshProvider = () => {},
  onRun,
  onShare,
  runOverlay,
  onInbox = () => {},
  onSession = () => {},
  assistantAdded = [],
  dock,
}: Props) {
  const state = useEditorState({
    hostId,
    directory,
    workflowName,
    catalog,
    draft,
    api,
  });
  const section = useRef<HTMLElement>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [overlayOn, setOverlayOn] = useState(true);
  const [closing, setClosing] = useState(false);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [jobsVersion, setJobsVersion] = useState(0);
  const [addRequest, setAddRequest] = useState<AddRequest | null>(null);
  const [reviewed, setReviewed] = useState<string[]>([]);
  const freshAssistantAdded = useMemo(
    () => assistantAdded.filter(name => !reviewed.includes(name)),
    [assistantAdded, reviewed],
  );
  const markReviewed = (id: string) =>
    setReviewed(current => (current.includes(id) ? current : [...current, id]));
  const editorState = {
    ...state,
    select: (next: Parameters<typeof state.select>[0]) => {
      if (next.kind === 'node') markReviewed(next.id);
      state.select(next);
    },
  };
  useEffect(() => {
    onDirtyChange?.(state.dirty);
  }, [onDirtyChange, state.dirty]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    let active = true;
    scheduledJobsApi.list(hostId).then(
      list => {
        if (active) setJobs(list);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [scheduledJobsApi, hostId, jobsVersion]);
  const automations = useMemo(
    () => jobs.filter(job => job.workflow?.name === state.document.name),
    [jobs, state.document.name],
  );
  const runBadges = useMemo(() => {
    if (!overlayOn || !runOverlay) return null;
    const latest = latestAttempts(runOverlay.steps);
    const badges = new Map<string, RunBadge>();
    runOverlay.run.workflow.steps.forEach((step, index) => {
      const record = latest.get(index);
      badges.set(step.name, {
        state: record?.state ?? 'pending',
        attempts: record ? Math.max(record.attempt, 1) : 0,
      });
    });
    return badges;
  }, [overlayOn, runOverlay]);
  const savedDocument = useMemo<WorkflowAssistantDocument | null>(
    () =>
      !state.dirty && state.document.hash && state.document.name
        ? {
            kind: 'workflow',
            scope: state.document.scope,
            name: state.document.name,
            contentHash: state.document.hash,
            text: toFileText(state.document),
          }
        : null,
    [state.dirty, state.document],
  );
  const dockSelection = useMemo(
    () => (state.selection.kind === 'node' ? [state.selection.id] : []),
    [state.selection],
  );
  const { document } = state;
  const requestAdd = useCallback(
    (origin: AddOrigin, event: ReactMouseEvent) => {
      const frame = section.current?.getBoundingClientRect();
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const anchor = {
        x: rect.right - (frame?.left ?? 0),
        y: rect.top + rect.height / 2 - (frame?.top ?? 0),
      };
      const sourceId =
        origin.kind === 'after'
          ? origin.id
          : origin.kind === 'edge'
            ? document.edges.find(edge => edge.id === origin.id)?.from
            : undefined;
      const phase =
        document.nodes.find(node => node.id === sourceId)?.step.phase ?? null;
      setAddRequest({ origin, phase, anchor });
    },
    [document],
  );
  const requestClose = () => {
    if (state.dirty) setClosing(true);
    else onClose();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.defaultPrevented) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('[data-assistant-dock]')
    )
      return;
    if (modifier && key === 's') {
      event.preventDefault();
      if (state.dirty && !state.validation.hasErrors) void state.save();
      return;
    }
    if (isTextTarget(event.target)) return;
    if (modifier && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) state.redo();
      else state.undo();
      return;
    }
    if (modifier && key === 'y') {
      event.preventDefault();
      state.redo();
      return;
    }
    if (modifier && key === 'd') {
      event.preventDefault();
      if (state.selection.kind === 'node')
        state.duplicateNode(state.selection.id);
      return;
    }
    if (event.key === 'Delete') {
      if (state.selection.kind === 'node') {
        event.preventDefault();
        state.removeNode(state.selection.id);
      } else if (state.selection.kind === 'edge') {
        event.preventDefault();
        state.removeEdge(state.selection.id);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (addRequest) setAddRequest(null);
      else state.select({ kind: 'none' });
    }
  };
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  return (
    <section
      ref={section}
      aria-label="Graph editor"
      data-graph-editor={state.document.name || 'new'}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ReactFlowProvider>
        <Toolbar
          state={editorState}
          directory={directory}
          statuses={statuses}
          issuesOpen={issuesOpen}
          onToggleIssues={() => setIssuesOpen(value => !value)}
          overlay={{
            available: !!runOverlay,
            on: overlayOn,
            onToggle: () => setOverlayOn(value => !value),
          }}
          onRefreshProvider={onRefreshProvider}
          onRun={onRun ?? null}
          onShare={onShare ?? null}
          onClose={requestClose}
        />
        <IssuesStrip
          issues={state.issues}
          banner={state.banner}
          open={issuesOpen}
        />
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <EditorCanvas
                state={editorState}
                runBadges={runBadges}
                automations={automations.length}
                assistantAdded={freshAssistantAdded}
                onRequestAdd={requestAdd}
              />
              {state.notice && (
                <p
                  role="alert"
                  data-editor-notice
                  className="pointer-events-none absolute top-3 left-1/2 z-10 max-w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-surface border bg-card px-3 py-1.5 text-xs text-card-foreground shadow-(--popover-shadow) [overflow-wrap:anywhere]"
                >
                  {state.notice}
                </p>
              )}
            </div>
            <div
              data-slot="editor-dock"
              className="absolute right-3 bottom-3 z-10 has-[[data-assistant-dock]]:static has-[[data-assistant-dock]]:shrink-0 has-[[data-assistant-dock]]:border-t [&_[data-assistant-dock]]:max-h-[min(43vh,23rem)] [&_[data-assistant-dock]]:w-full! [&_[data-assistant-dock]]:max-w-none [&_[data-assistant-dock]]:rounded-none [&_[data-assistant-dock]]:border-0"
            >
              {dock && (
                <EditorDock
                  render={dock}
                  workflowName={
                    savedDocument?.name ??
                    workflowName ??
                    (state.document.name || null)
                  }
                  document={savedDocument}
                  selection={dockSelection}
                  onApplied={() => void state.reload()}
                  onFocusStep={name =>
                    editorState.select({ kind: 'node', id: name })
                  }
                />
              )}
            </div>
          </div>
          <InspectorPanel
            state={editorState}
            hostId={hostId}
            directory={directory}
            automations={automations}
            specs={state.catalog.specs}
            computers={computers}
            statuses={statuses}
            onSaveAutomation={async (input, expectedRevision) => {
              await scheduledJobsApi.save(hostId, input, expectedRevision);
              setJobsVersion(version => version + 1);
            }}
            onRefreshAutomations={() => setJobsVersion(version => version + 1)}
            overlay={overlayOn && runOverlay ? runOverlay : null}
            api={api}
            onInbox={onInbox}
            onSession={onSession}
          />
        </div>
      </ReactFlowProvider>
      <NodePicker
        request={addRequest}
        steps={state.catalog.steps}
        inWorkflow={document.nodes.map(node => node.id)}
        onPickStep={(step, origin) => state.addCatalogStep(step, origin)}
        onNewStep={(type, phase, origin) =>
          state.startDraft({ type, phase: phase ?? undefined, origin })
        }
        onAddSchedule={() => state.select({ kind: 'start' })}
        onClose={() => setAddRequest(null)}
      />
      <ConflictDialog
        conflict={state.conflict}
        onResolve={choice => void state.resolveConflict(choice)}
      />
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title="Discard unsaved changes?"
        description="The workflow file was not written. Closing the editor drops the edits made since the last save."
        cancelLabel="Keep editing"
        confirmLabel="Discard and close"
        onConfirm={onClose}
      />
    </section>
  );
}
