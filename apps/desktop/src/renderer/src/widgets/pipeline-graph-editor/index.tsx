import '@xyflow/react/dist/base.css';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type {
  Computer,
  DefinitionCatalog,
  DesktopApi,
  ScheduledJob,
} from '@nesvo/contracts';
import {
  latestAttempts,
  type PipelineRun,
  type PipelineStepRecord,
  type StepDisplayState,
} from '@/entities/pipeline';
import type { ProviderStates } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import type { InboxTarget } from '@/widgets/pipeline-step-result';
import { EditorCanvas } from './canvas';
import { ConflictDialog } from './conflict-dialog';
import type { SkillSummary } from './inspector';
import { InspectorPanel } from './inspector-panel';
import { IssuesStrip } from './issues-strip';
import { Toolbar } from './toolbar';
import { useEditorState } from './use-editor-state';

type Props = {
  hostId: string;
  directory: string;
  pipelineName: string | null;
  catalog: DefinitionCatalog;
  api: DesktopApi['pipelines'];
  scheduledJobsApi: DesktopApi['scheduledJobs'];
  computers: Computer[];
  statuses: ProviderStates;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onDiscoverSkills?: (directory: string) => Promise<SkillSummary[]>;
  runOverlay?: { run: PipelineRun; steps: PipelineStepRecord[] };
  onInbox?: (target: InboxTarget) => void;
  onSession?: (key: string) => void;
};

const isTextTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.closest('input, textarea, select, [contenteditable="true"]') !==
    null ||
    target.closest('[role="dialog"]') !== null);

export default function PipelineGraphEditor({
  hostId,
  directory,
  pipelineName,
  catalog,
  api,
  scheduledJobsApi,
  computers,
  statuses,
  onClose,
  onDirtyChange,
  onDiscoverSkills,
  runOverlay,
  onInbox = () => {},
  onSession = () => {},
}: Props) {
  const state = useEditorState({
    hostId,
    directory,
    pipelineName,
    catalog,
    api,
  });
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [overlayOn, setOverlayOn] = useState(false);
  const [closing, setClosing] = useState(false);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [jobsVersion, setJobsVersion] = useState(0);
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
  useEffect(() => {
    if (!onDiscoverSkills) return;
    let active = true;
    onDiscoverSkills(directory).then(
      list => {
        if (active) setSkills(list);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [onDiscoverSkills, directory]);
  const automations = useMemo(
    () => jobs.filter(job => job.pipeline?.name === state.document.name),
    [jobs, state.document.name],
  );
  const runStates = useMemo(() => {
    if (!overlayOn || !runOverlay) return null;
    const latest = latestAttempts(runOverlay.steps);
    const states = new Map<string, StepDisplayState>();
    runOverlay.run.pipeline.steps.forEach((step, index) => {
      states.set(step.name, latest.get(index)?.state ?? 'pending');
    });
    return states;
  }, [overlayOn, runOverlay]);
  const requestClose = () => {
    if (state.dirty) setClosing(true);
    else onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (state.dirty && !state.validation.hasErrors) void state.save();
      return;
    }
    if (event.key === 'Escape' && !isTextTarget(event.target)) {
      event.preventDefault();
      state.select({ kind: 'pipeline' });
    }
  };
  return (
    <section
      aria-label="Graph editor"
      data-graph-editor={state.document.name || 'new'}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
    >
      <ReactFlowProvider>
        <Toolbar
          state={state}
          catalogSteps={state.catalog.steps}
          issuesOpen={issuesOpen}
          onToggleIssues={() => setIssuesOpen(value => !value)}
          overlay={{
            available: !!runOverlay,
            on: overlayOn,
            onToggle: () => setOverlayOn(value => !value),
          }}
          onClose={requestClose}
        />
        <IssuesStrip
          issues={state.issues}
          banner={state.banner}
          open={issuesOpen}
        />
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <EditorCanvas
              state={state}
              runStates={runStates}
              automations={automations.length}
            />
            {state.notice && (
              <p
                role="alert"
                data-editor-notice
                className="pointer-events-none absolute top-3 left-1/2 z-10 max-w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border bg-card px-3 py-1.5 text-xs text-card-foreground shadow-(--popover-shadow) [overflow-wrap:anywhere]"
              >
                {state.notice}
              </p>
            )}
            <div
              data-slot="editor-dock"
              className="pointer-events-none absolute right-3 bottom-3 z-10 [&>*]:pointer-events-auto"
            />
          </div>
          <InspectorPanel
            state={state}
            hostId={hostId}
            directory={directory}
            skills={skills}
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
      <ConflictDialog
        conflict={state.conflict}
        onResolve={choice => void state.resolveConflict(choice)}
      />
      <Dialog open={closing} onOpenChange={setClosing}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">
              Discard unsaved changes?
            </DialogTitle>
            <DialogDescription className="text-xs">
              The pipeline file was not written. Closing the editor drops the
              edits made since the last save.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setClosing(false)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setClosing(false);
                onClose();
              }}
            >
              Discard and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
