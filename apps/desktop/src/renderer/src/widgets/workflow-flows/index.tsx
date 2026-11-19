import '@xyflow/react/dist/base.css';
import { useCallback, useMemo, useState } from 'react';
import {
  MarkerType,
  ReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Network, Workflow } from 'lucide-react';
import type {
  Computer,
  CoordinatorWakeState,
  DecisionRoute,
  DesktopSession,
  DesktopWorkflowRun,
  DesktopWorkflowStepRecord,
} from '@nesvo/contracts';
import { elapsedLabel } from '@/entities/activity';
import type { Review } from '@/entities/review';
import type { HostedInboxItem } from '@/features/inbox-rules';
import { directoryLabel } from '@/entities/session';
import {
  autoLayout,
  COLUMN_WIDTH_PX,
  edgeTones,
  editorEdge,
  NODE_HEIGHT_PX,
  stepTypeLabels,
  toneColor,
} from '@/entities/workflow-graph';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { IconButton } from '@/shared/ui/icon-button';
import { EmptyState } from '@/shared/ui/empty-state';
import { ListRow } from '@/shared/ui/list-row';
import { Panel, PanelBody, PanelHeader, Toolbar } from '@/shared/ui/panel';
import { StatusDot } from '@/shared/ui/status-dot';
import { Hint } from '@/shared/ui/tooltip';
import { ZoomControls } from '@/shared/ui/zoom-controls';
import { edgeTypes } from '@/widgets/workflow-graph-editor/canvas-types';
import type { ConditionEdge } from '@/widgets/workflow-graph-editor/edges';
import {
  StepNodeView,
  type StepNodeData,
} from '@/widgets/workflow-graph-editor/nodes';
import {
  flowCounts,
  flowProjects,
  workflowFlows,
  type FlowRow,
  type WorkflowFlow,
} from './flow-model';

import {
  orchestrationAnchor,
  orchestrationTrees,
  type InboxTarget,
  type OrchestrationNode,
} from './orchestration-model';
import { OrchestrationTrees } from './orchestration-trees';
import { SessionPullRequest } from './session-pull-request';

const NODE_WIDTH = 280;
const ROW_HEIGHT = 28;
const VISIBLE_ROWS = 5;
const COLUMN_SPACING = 72;
const GRAPH_GUTTER = 8;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const ZOOM_STEP = 1.2;

const clampZoom = (zoom: number) =>
  Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

const sessionRowsHeight = (count: number) =>
  count ? Math.min(VISIBLE_ROWS, count) * ROW_HEIGHT + 6 : 0;

type RowActions = {
  onSession: (session: DesktopSession) => void;
  orchestrationKeys?: ReadonlySet<string>;
};

type Props = RowActions & {
  computers: Computer[];
  sessions: DesktopSession[];
  runs: DesktopWorkflowRun[];
  steps: DesktopWorkflowStepRecord[];
  wakeStates: ReadonlyMap<string, CoordinatorWakeState>;
  reviews: Review[];
  inboxItems: HostedInboxItem[];
  routeOf: (session: DesktopSession) => DecisionRoute;
  onInbox: (target: InboxTarget) => void;
  onDecisionSession: (key: string) => void;
};

type FlowStepNode = Node<
  StepNodeData & RowActions & { rows: FlowRow[] },
  'flow-step'
>;

function SessionRows({
  rows,
  onSession,
  orchestrationKeys,
}: RowActions & { rows: FlowRow[] }) {
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
                <>
                  {orchestrationKeys?.has(entityKey(session)) && (
                    <IconButton
                      label={`Show orchestration for ${session.title}`}
                      size={24}
                      onClick={() => {
                        const tree = document.getElementById(
                          orchestrationAnchor(entityKey(session)),
                        );
                        tree?.scrollIntoView({ block: 'nearest' });
                        tree?.focus({ preventScroll: true });
                      }}
                    >
                      <Network />
                    </IconButton>
                  )}
                  <SessionPullRequest session={session} />
                </>
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

function layoutGraph(flow: WorkflowFlow) {
  const steps = graphNodes(flow);
  return {
    steps,
    width: Math.max(0, ...steps.map(step => step.position.x + NODE_WIDTH)),
    height: Math.max(
      0,
      ...steps.map(
        (step, index) =>
          step.position.y +
          NODE_HEIGHT_PX +
          sessionRowsHeight(flow.rows.get(index)?.length ?? 0),
      ),
    ),
  };
}

function FlowGraph({
  flow,
  layout,
  zoom,
  onSession,
  orchestrationKeys,
}: RowActions & {
  flow: WorkflowFlow;
  layout: ReturnType<typeof layoutGraph>;
  zoom: number;
}) {
  const nodes: FlowStepNode[] = layout.steps.map((editor, index) => {
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
        orchestrationKeys,
        summary: flowCounts(rows) || stepTypeLabels[editor.step.type],
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
  const between = flow.rows.get(null);
  return (
    <div className="overflow-x-auto">
      {between && (
        <div className="ml-2 max-w-sm pb-1">
          <p className="py-1 text-ui text-muted-foreground">Between steps</p>
          <SessionRows
            rows={between}
            onSession={onSession}
            orchestrationKeys={orchestrationKeys}
          />
        </div>
      )}
      {layout.steps.length > 0 && (
        <div
          style={{
            minWidth: Math.ceil(layout.width * zoom) + 2 * GRAPH_GUTTER,
            height: Math.ceil(layout.height * zoom) + 2 * GRAPH_GUTTER,
          }}
        >
          <ReactFlow<FlowStepNode, ConditionEdge>
            id={`flow-${flow.run.id}`}
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
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            viewport={{ x: GRAPH_GUTTER, y: GRAPH_GUTTER, zoom }}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            proOptions={{ hideAttribution: true }}
            className="bg-background text-foreground"
            aria-label={`${flow.run.workflow.name} flow graph`}
          />
        </div>
      )}
    </div>
  );
}

export default function WorkflowFlows({
  computers,
  sessions,
  runs,
  steps,
  onSession,
  wakeStates,
  reviews,
  inboxItems,
  routeOf,
  onInbox,
  onDecisionSession,
}: Props) {
  const flows = useMemo(
    () => workflowFlows(sessions, runs, steps),
    [sessions, runs, steps],
  );
  const projects = useMemo(() => flowProjects(flows), [flows]);
  const layouts = useMemo(
    () => new Map(flows.map(flow => [flow.id, layoutGraph(flow)])),
    [flows],
  );
  const [width, setWidth] = useState(0);
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const measureGraphs = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const widest = Math.max(0, ...[...layouts.values()].map(item => item.width));
  const fitZoom =
    widest && width
      ? clampZoom(Math.min(1, (width - 2 * GRAPH_GUTTER) / widest))
      : 1;
  const zoom = manualZoom ?? fitZoom;
  const workflowSessions = new Set(
    flows.flatMap(flow =>
      [...flow.rows.values()].flat().map(row => entityKey(row.session)),
    ),
  );
  const trees = orchestrationTrees(
    sessions,
    wakeStates,
    reviews,
    inboxItems,
    routeOf,
    workflowSessions,
  );
  const orchestrationKeys = new Set<string>();
  const collect = (tree: OrchestrationNode) => {
    if (!tree.children.length) return;
    orchestrationKeys.add(entityKey(tree.session));
    tree.children.forEach(collect);
  };
  trees.forEach(collect);
  const active = flows.length > 0 || trees.length > 0;
  return (
    <Panel aria-label="Flows" className="relative flex-1">
      <PanelBody>
        {active ? (
          <div className="mx-auto max-w-6xl space-y-4 px-5 pt-5 pb-14 xl:ml-5">
            {trees.length > 0 && (
              <OrchestrationTrees
                computers={computers}
                trees={trees}
                actions={{ onSession, onInbox, onDecisionSession }}
              />
            )}
            <div ref={measureGraphs} className="space-y-6">
              {projects.map(project => {
                const computer = computers.find(
                  item => item.id === project.hostId,
                );
                return (
                  <section
                    key={project.id}
                    aria-label={directoryLabel(project.directory)}
                  >
                    <h2
                      title={project.directory}
                      className="px-2 py-1 text-xs text-muted-foreground"
                    >
                      {[
                        directoryLabel(project.directory),
                        computer?.name,
                        computer?.status !== 'connected' && 'Offline',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </h2>
                    {[...project.workflows].map(([name, graphs]) => {
                      const rows = graphs.flatMap(flow =>
                        [...flow.rows.values()].flat(),
                      );
                      return (
                        <section
                          key={name}
                          aria-label={name}
                          className="border-b border-info-panel-divider pt-1 pb-3"
                        >
                          <PanelHeader
                            title={name}
                            meta={[
                              graphs.some(flow =>
                                flow.statuses.has('awaiting-human'),
                              )
                                ? 'Waiting for a decision in Inbox'
                                : graphs.some(flow =>
                                    flow.statuses.has('implementing'),
                                  ) && 'Running',
                              flowCounts(rows),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                            className="h-8 border-b-0 pl-2"
                          />
                          {graphs.map(flow => (
                            <FlowGraph
                              key={flow.id}
                              flow={flow}
                              layout={layouts.get(flow.id)!}
                              zoom={zoom}
                              onSession={onSession}
                              orchestrationKeys={orchestrationKeys}
                            />
                          ))}
                        </section>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </div>
        ) : (
          <EmptyState icon={Workflow} title="No live flows" />
        )}
      </PanelBody>
      {widest > 0 && (
        <Toolbar
          label="Flows zoom controls"
          bordered={false}
          className="absolute bottom-3 left-5 z-10 h-auto gap-0.5 rounded-surface border bg-background p-0.5 xl:left-10"
        >
          <ZoomControls
            zoom={zoom}
            onZoomOut={() => setManualZoom(clampZoom(zoom / ZOOM_STEP))}
            onZoomIn={() => setManualZoom(clampZoom(zoom * ZOOM_STEP))}
            onFit={() => setManualZoom(null)}
            fitLabel="Fit graphs"
          />
        </Toolbar>
      )}
    </Panel>
  );
}
