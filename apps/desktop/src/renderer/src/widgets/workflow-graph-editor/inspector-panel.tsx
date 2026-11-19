import {
  FileText,
  GitBranch,
  Play,
  SquarePen,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type {
  Computer,
  WorkflowsApi,
  ScheduledJob,
  TaskSpecSummary,
} from '@nesvo/contracts';
import {
  phaseLabels,
  workflowSteps,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '@/entities/workflow';
import { StepStateIcon } from '@/entities/workflow/step-state-icon';
import {
  isDraftStep,
  stepDraftOf,
  usedBy,
  type NodeIssue,
} from '@/entities/workflow-graph';
import type { ProviderStates } from '@/entities/session';
import { PanelBody } from '@/shared/ui/panel';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StepResult, type InboxTarget } from '@/widgets/workflow-step-result';
import {
  EdgeInspector,
  WorkflowInspector,
  StartInspector,
  StepInspector,
  type AutomationInput,
  type InspectorIssue,
} from './inspector';
import { InspectorGateRules } from './inspector/gate-rules';
import type { EditorState } from './use-editor-state';

type Props = {
  state: EditorState;
  hostId: string;
  directory: string;
  automations: ScheduledJob[];
  specs: TaskSpecSummary[];
  computers: Computer[];
  statuses: ProviderStates;
  onSaveAutomation: (
    input: AutomationInput,
    expectedRevision: number | null,
  ) => Promise<void>;
  onRefreshAutomations: () => void;
  overlay: { run: WorkflowRun; steps: WorkflowStepRecord[] } | null;
  api: Pick<WorkflowsApi, 'readEvidence'>;
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
  if (selection.kind === 'none') return null;
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
      ? workflowSteps(overlay.run, overlay.steps).find(
          step => step.definition.name === node.id,
        )
      : undefined;
  const showResult = !!runStep && !!overlay && runStep.state !== 'pending';
  const header: { icon: LucideIcon; title: string; meta?: string } =
    selection.kind === 'draft'
      ? { icon: SquarePen, title: 'New step' }
      : node
        ? {
            icon: showResult ? Play : SquarePen,
            title: showResult ? 'Last run' : 'Step',
            meta: node.id,
          }
        : edge
          ? { icon: GitBranch, title: 'Connection', meta: edge.id }
          : selection.kind === 'start'
            ? { icon: Zap, title: 'Start' }
            : { icon: FileText, title: 'Workflow settings' };
  const workflowIssues = state.issues.filter(issue => issue.steps.length === 0);
  const gateRules = node?.step.type === 'agent' && (
    <InspectorGateRules
      key={node.id}
      initial={state.catalog.gateRules ?? []}
      directory={directory}
      hostId={hostId}
      step={node.id}
      workflow={document.name}
    />
  );
  return (
    <SidePanel
      kind="inspector"
      resizeLabel="Resize workflow inspector"
      role="complementary"
      aria-label="Inspector"
      data-editor-inspector={selection.kind}
    >
      <SidePanelHeader
        titleBar={false}
        className="[&>span]:text-ui"
        icon={header.icon}
        title={header.title}
        meta={header.meta}
        closeLabel="Close inspector"
        onClose={() => state.select({ kind: 'none' })}
      />
      <div
        key={showResult ? 'last-run' : selection.kind}
        className="flex min-h-0 flex-1 flex-col"
      >
        {selection.kind === 'draft' && state.pendingDraft && (
          <StepInspector
            step={state.pendingDraft}
            mode="create"
            usedBy={[]}
            hostId={hostId}
            directory={directory}
            issues={state.draftProblems}
            onChange={state.updateDraft}
            onSave={state.commitDraft}
            onDelete={state.cancelDraft}
          />
        )}
        {node && showResult && overlay && runStep && (
          <PanelBody>
            {gateRules}
            <div className="space-y-3 p-3">
              <div className="flex items-center gap-2 text-ui">
                <StepStateIcon state={runStep.state} className="size-4" />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {node.id}
                </span>
                <span className="shrink-0 text-ui text-muted-foreground">
                  {phaseLabels[node.step.phase]}
                  {runStep.attempts > 1 ? ` · attempt ${runStep.attempts}` : ''}
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
          </PanelBody>
        )}
        {node && !showResult && (
          <StepInspector
            key={isDraftStep(node.step) ? 'draft-step' : node.id}
            step={stepDraftOf(node.step)}
            mode="edit"
            beforeFields={gateRules}
            renamable={isDraftStep(node.step)}
            usedBy={usedBy(state.catalog, node.id, document.name)}
            hostId={hostId}
            directory={directory}
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
            onChange={when => state.updateEdge(edge.id, { when })}
            onPredicate={predicate => state.updateEdge(edge.id, { predicate })}
            onDelete={() => state.removeEdge(edge.id)}
          />
        )}
        {selection.kind === 'start' && (
          <PanelBody>
            <StartInspector
              hostId={hostId}
              directory={directory}
              workflowName={document.name}
              specs={specs}
              automations={automations}
              computers={computers}
              statuses={statuses}
              onSaveAutomation={onSaveAutomation}
              onRefresh={onRefreshAutomations}
            />
          </PanelBody>
        )}
        {selection.kind === 'workflow' && (
          <PanelBody>
            <WorkflowInspector
              name={document.name}
              description={document.description}
              body={document.body}
              scope={document.scope}
              mode={document.hash ? 'edit' : 'create'}
              issues={toInspectorIssues(workflowIssues)}
              onChange={state.setWorkflowFields}
            />
          </PanelBody>
        )}
      </div>
    </SidePanel>
  );
}
