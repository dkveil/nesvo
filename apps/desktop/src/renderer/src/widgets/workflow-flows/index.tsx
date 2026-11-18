import '@xyflow/react/dist/base.css';
import { useMemo } from 'react';
import {
  MarkerType,
  ReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { GitPullRequest, Workflow } from 'lucide-react';
import type {
  Computer,
  DesktopSession,
  DesktopWorkflowRun,
  DesktopWorkflowStepRecord,
} from '@nesvo/contracts';
import { elapsedLabel } from '@/entities/activity';
import { pullRequestUrl } from '@/entities/pull-request';
import { directoryLabel } from '@/entities/session';
import {
  autoLayout,
  COLUMN_WIDTH_PX,
  edgeTones,
  editorEdge,
  NODE_HEIGHT_PX,
  ROW_HEIGHT_PX,
  toneColor,
} from '@/entities/workflow-graph';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { ListRow } from '@/shared/ui/list-row';
import { Panel, PanelBody, PanelHeader } from '@/shared/ui/panel';
import { StatusDot } from '@/shared/ui/status-dot';
import { Hint } from '@/shared/ui/tooltip';
import { CanvasControls } from '@/widgets/workflow-graph-editor/canvas-controls';
import {
  edgeTypes,
  fitViewOptions,
} from '@/widgets/workflow-graph-editor/canvas-types';
import type { ConditionEdge } from '@/widgets/workflow-graph-editor/edges';
import {
  StepNodeView,
  type StepNodeData,
} from '@/widgets/workflow-graph-editor/nodes';
import {
  flowCounts,
  workflowFlows,
  type FlowRow,
  type WorkflowFlow,
} from './flow-model';

const NODE_WIDTH = 280;
const ROW_HEIGHT = 28;
const VISIBLE_ROWS = 5;
const COLUMN_SPACING = 72;

const sessionRowsHeight = (count: number) =>
  count ? Math.min(VISIBLE_ROWS, count) * ROW_HEIGHT + 6 : 0;

type RowActions = {
  onSession: (session: DesktopSession) => void;
};

type Props = RowActions & {
  computers: Computer[];
  sessions: DesktopSession[];
  runs: DesktopWorkflowRun[];
  steps: DesktopWorkflowStepRecord[];
};

type FlowStepNode = Node<
  StepNodeData & RowActions & { rows: FlowRow[] },
  'flow-step'
>;

function SessionRows({ rows, onSession }: RowActions & { rows: FlowRow[] }) {
  const now = useNow(1000);
  return (
    <div
      className="nodrag nopan nowheel pointer-events-auto overflow-y-auto"
      style={{ maxHeight: ROW_HEIGHT * VISIBLE_ROWS }}
    >
      {rows.map(row => {
        const { session } = row;
        const elapsed = elapsedLabel(row.startedAt, row.finishedAt, now);
        const label = [
          session.title,
          session.provider,
          session.actualModel ?? session.model,
          row.detail,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <Hint key={entityKey(session)} label={label}>
            <ListRow
              data-flow-session={session.id}
              level={Math.min(row.depth, 2)}
              leading={
                <StatusDot
                  tone={row.tone}
                  variant={row.variant}
                  size="md"
                  label={row.state}
                />
              }
              title={session.title}
              trailing={
                <time dateTime={row.startedAt} className="text-ui">
                  {elapsed}
                </time>
              }
              mainProps={{
                'aria-label': [
                  `Open ${session.title}`,
                  row.state,
                  elapsed,
                  row.detail,
                ]
                  .filter(Boolean)
                  .join(', '),
              }}
              onClick={() => onSession(session)}
              actionsPlacement="visible"
              actions={
                session.pullRequest && (
                  <Button size="xs" variant="ghost" asChild>
                    <a
                      href={pullRequestUrl(session.pullRequest)}
                      aria-label={`Open PR #${session.pullRequest.number} for ${session.title}`}
                      onClick={event => {
                        event.preventDefault();
                        void window.nesvo
                          .openExternal(event.currentTarget.href)
                          .catch(() => undefined);
                      }}
                    >
                      <GitPullRequest /> #{session.pullRequest.number}
                    </a>
                  </Button>
                )
              }
            />
          </Hint>
        );
      })}
    </div>
  );
}

function FlowStep({ data, selected }: NodeProps<FlowStepNode>) {
  return (
    <div data-flow-step={data.editor.id} style={{ width: NODE_WIDTH }}>
      <StepNodeView selected={selected} data={data} />
      {data.rows.length > 0 && (
        <div className="mt-1 rounded-surface border border-info-panel-border bg-info-panel">
          <SessionRows {...data} />
        </div>
      )}
    </div>
  );
}

const nodeTypes = { 'flow-step': FlowStep };

function graphNodes(flow: WorkflowFlow) {
  const edges = flow.run.workflow.graph.edges.map(editorEdge);
  const nodes = flow.run.workflow.steps.map(step => ({
    id: step.name,
    step,
    position: { x: 0, y: 0 },
    issues: [],
  }));
  const positions = autoLayout(nodes, edges);
  const layers = new Map<number, number>();
  nodes.forEach((node, index) => {
    const { y } = positions[node.id]!;
    const height = sessionRowsHeight(flow.rows.get(index)?.length ?? 0);
    layers.set(y, Math.max(layers.get(y) ?? 0, height));
  });
  let dy = 0;
  for (const y of [...layers.keys()].sort((a, b) => a - b)) {
    const height = layers.get(y) ?? 0;
    layers.set(y, dy);
    dy += height;
  }
  return nodes.map(node => {
    const { x, y } = positions[node.id]!;
    return {
      ...node,
      position: {
        x: x * ((NODE_WIDTH + COLUMN_SPACING) / COLUMN_WIDTH_PX),
        y: y + (layers.get(y) ?? 0),
      },
    };
  });
}

function FlowGraph({ flow, onSession }: RowActions & { flow: WorkflowFlow }) {
  const steps = useMemo(() => graphNodes(flow), [flow]);
  const nodes: FlowStepNode[] = steps.map((editor, index) => {
    const rows = flow.rows.get(index) ?? [];
    return {
      id: editor.id,
      type: 'flow-step',
      position: editor.position,
      measured: {
        width: NODE_WIDTH,
        height: NODE_HEIGHT_PX + sessionRowsHeight(rows.length),
      },
      data: {
        editor,
        rows,
        onSession,
        summary: flowCounts(rows),
        width: NODE_WIDTH,
        issues: [],
        run: null,
        addedByAssistant: false,
        freeSuccess: false,
        freeFailure: false,
      },
    };
  });
  const edges = useMemo<ConditionEdge[]>(
    () =>
      flow.run.workflow.graph.edges.map(edge => ({
        id: editorEdge(edge).id,
        source: edge.from,
        target: edge.to,
        sourceHandle: edge.when === 'failure' ? 'failure' : 'success',
        targetHandle: 'in',
        type: 'condition',
        data: { when: edge.when },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: toneColor[edgeTones[edge.when]],
          width: 14,
          height: 14,
        },
      })),
    [flow.run.workflow],
  );
  const bottom = Math.max(
    ...steps.map(
      (step, index) =>
        step.position.y +
        NODE_HEIGHT_PX +
        sessionRowsHeight(flow.rows.get(index)?.length ?? 0),
    ),
  );
  return (
    <div
      style={{
        height: Math.min(560, Math.max(240, bottom + ROW_HEIGHT_PX + 20)),
      }}
    >
      <ReactFlow<FlowStepNode, ConditionEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className="bg-background text-foreground"
        aria-label={`${flow.run.workflow.name} flow graph`}
      >
        <CanvasControls />
      </ReactFlow>
    </div>
  );
}

export default function WorkflowFlows({
  computers,
  sessions,
  runs,
  steps,
  onSession,
}: Props) {
  const flows = useMemo(
    () => workflowFlows(sessions, runs, steps),
    [sessions, runs, steps],
  );
  const active = flows.length > 0;
  return (
    <Panel aria-label="Flows" className="flex-1">
      <PanelBody>
        {active ? (
          <div className="mx-auto max-w-6xl space-y-4 p-5">
            {flows.map(flow => {
              const { run } = flow;
              const rows = [...flow.rows.values()].flat();
              const between = flow.rows.get(null);
              const computer = computers.find(item => item.id === run.hostId);
              return (
                <Panel
                  key={flow.id}
                  aria-label={run.workflow.name}
                  className="overflow-hidden rounded-surface border border-info-panel-border bg-info-panel"
                >
                  <PanelHeader
                    title={run.workflow.name}
                    meta={[
                      computer?.name,
                      directoryLabel(run.projectRoot),
                      flowCounts(rows),
                      computer?.status !== 'connected' && 'Offline',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    className="border-info-panel-divider"
                  />
                  {between && (
                    <div className="border-b border-info-panel-divider px-2 py-1">
                      <p className="px-2 py-1 text-ui text-muted-foreground">
                        Between steps
                      </p>
                      <SessionRows rows={between} onSession={onSession} />
                    </div>
                  )}
                  <FlowGraph flow={flow} onSession={onSession} />
                </Panel>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Workflow} title="No live workflows" />
        )}
      </PanelBody>
    </Panel>
  );
}
