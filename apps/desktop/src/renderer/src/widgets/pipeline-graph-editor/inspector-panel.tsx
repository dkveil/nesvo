import {
  FileText,
  GitBranch,
  Play,
  SquarePen,
  X,
  type LucideIcon,
} from 'lucide-react';
import type {
  Computer,
  PipelinesApi,
  ScheduledJob,
  TaskSpecSummary,
} from '@nesvo/contracts';
import {
  phaseLabels,
  pipelineSteps,
  type PipelineRun,
  type PipelineStepRecord,
} from '@/entities/pipeline';
import { StepStateIcon } from '@/entities/pipeline/step-state-icon';
import { stepDraftOf, usedBy, type NodeIssue } from '@/entities/pipeline-graph';
import type { ProviderStates } from '@/entities/session';
import { PanelAction, PanelHeader } from '@/shared/ui/panel';
import { StepResult, type InboxTarget } from '@/widgets/pipeline-step-result';
import {
  EdgeInspector,
  PipelineInspector,
  StartInspector,
  StepInspector,
  type AutomationInput,
  type InspectorIssue,
  type SkillSummary,
} from './inspector';
import type { EditorState } from './use-editor-state';

type Props = {
  state: EditorState;
  hostId: string;
  directory: string;
  skills: SkillSummary[];
  automations: ScheduledJob[];
  specs: TaskSpecSummary[];
  computers: Computer[];
  statuses: ProviderStates;
  onSaveAutomation: (
    input: AutomationInput,
    expectedRevision: number | null,
  ) => Promise<void>;
  onRefreshAutomations: () => void;
  overlay: { run: PipelineRun; steps: PipelineStepRecord[] } | null;
  api: Pick<PipelinesApi, 'readEvidence'>;
  onInbox: (target: InboxTarget) => void;
  onSession: (key: string) => void;
};

const toInspectorIssues = (issues: NodeIssue[]): InspectorIssue[] =>
  issues.map(issue => ({
    severity: issue.severity,
    path: '',
    line: null,
    message: issue.message,
  }));

export function InspectorPanel({
  state,
  hostId,
  directory,
  skills,
  automations,
  specs,
  computers,
  statuses,
  onSaveAutomation,
  onRefreshAutomations,
  overlay,
  api,
  onInbox,
  onSession,
}: Props) {
  const { selection, document } = state;
  const node =
    selection.kind === 'node'
      ? document.nodes.find(item => item.id === selection.id)
      : undefined;
  const edge =
    selection.kind === 'edge'
      ? document.edges.find(item => item.id === selection.id)
      : undefined;
  const runStep =
    overlay && node
      ? pipelineSteps(overlay.run, overlay.steps).find(
          step => step.definition.name === node.id,
        )
      : undefined;
  const header: { icon: LucideIcon; title: string; meta?: string } =
    selection.kind === 'draft'
      ? { icon: SquarePen, title: 'New step' }
      : node
        ? {
            icon: runStep ? Play : SquarePen,
            title: runStep ? 'Last run' : 'Step',
            meta: node.id,
          }
        : edge
          ? { icon: GitBranch, title: 'Connection', meta: edge.id }
          : selection.kind === 'start'
            ? { icon: Play, title: 'Start' }
            : { icon: FileText, title: 'Pipeline' };
  const pipelineIssues = state.issues.filter(issue => issue.steps.length === 0);
  return (
    <aside
      aria-label="Inspector"
      data-editor-inspector={selection.kind}
      className="flex w-80 shrink-0 flex-col border-l"
    >
      <PanelHeader icon={header.icon} title={header.title} meta={header.meta}>
        {selection.kind !== 'pipeline' && (
          <PanelAction
            aria-label="Close inspector"
            onClick={() => state.select({ kind: 'pipeline' })}
          >
            <X />
          </PanelAction>
        )}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {selection.kind === 'draft' && state.pendingDraft && (
          <StepInspector
            step={state.pendingDraft}
            mode="create"
            usedBy={[]}
            skills={skills}
            issues={state.draftProblems}
            onChange={state.updateDraft}
            onSave={state.commitDraft}
            onDelete={state.cancelDraft}
          />
        )}
        {node && runStep && overlay && (
          <div className="space-y-3 px-3 py-3">
            <div className="flex items-center gap-2 text-xs">
              <StepStateIcon state={runStep.state} className="size-4" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {node.id}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {phaseLabels[node.step.phase]}
              </span>
            </div>
            <StepResult
              run={overlay.run}
              steps={overlay.steps}
              index={runStep.index}
              api={api}
              onInbox={onInbox}
              onSession={onSession}
            />
          </div>
        )}
        {node && !runStep && (
          <StepInspector
            key={node.id}
            step={stepDraftOf(node.step)}
            mode="edit"
            usedBy={usedBy(state.catalog, node.id, document.name)}
            skills={skills}
            issues={toInspectorIssues(state.nodeIssues.get(node.id) ?? [])}
            onChange={draft => state.updateStep(node.id, draft)}
            onSave={() => {
              if (state.validation.hasErrors)
                state.showNotice('Fix the errors before saving.');
              else void state.save();
            }}
            onDelete={() => state.removeNode(node.id)}
          />
        )}
        {edge && (
          <EdgeInspector
            key={edge.id}
            edge={edge}
            sourceType={
              document.nodes.find(item => item.id === edge.from)?.step.type ??
              'command'
            }
            onChange={when => state.setEdgeWhen(edge.id, when)}
            onDelete={() => state.removeEdge(edge.id)}
          />
        )}
        {selection.kind === 'start' && (
          <StartInspector
            hostId={hostId}
            directory={directory}
            pipelineName={document.name}
            specs={specs}
            automations={automations}
            computers={computers}
            statuses={statuses}
            onSaveAutomation={onSaveAutomation}
            onRefresh={onRefreshAutomations}
          />
        )}
        {selection.kind === 'pipeline' && (
          <PipelineInspector
            name={document.name}
            description={document.description}
            body={document.body}
            scope={document.scope}
            mode={document.hash ? 'edit' : 'create'}
            issues={toInspectorIssues(pipelineIssues)}
            onChange={state.setPipelineFields}
          />
        )}
      </div>
    </aside>
  );
}
