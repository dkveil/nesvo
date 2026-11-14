import { useMemo, useState, type CSSProperties } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  useReactFlow,
  useStoreApi,
  type EdgeChange,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import type { StepDisplayState } from '@/entities/pipeline';
import {
  LANE_TOP_PADDING_PX,
  START_NODE_X,
  edgeTones,
  laneTop,
  toneColor,
} from '@/entities/pipeline-graph';
import { START_NODE_ID, edgeTypes, nodeTypes } from './canvas-types';
import type { ConditionEdge } from './edges';
import { Lanes } from './lanes';
import type { EditorCanvasNode } from './nodes';
import type { EditorState } from './use-editor-state';

type Props = {
  state: EditorState;
  runStates: Map<string, StepDisplayState> | null;
  automations: number;
};

const canvasVariables = {
  '--xy-background-color': 'var(--background)',
  '--xy-handle-background-color': 'var(--muted-foreground)',
  '--xy-handle-border-color': 'var(--background)',
  '--xy-edge-stroke': 'var(--border)',
  '--xy-edge-stroke-selected': 'var(--foreground)',
  '--xy-connectionline-stroke': 'var(--muted-foreground)',
  '--xy-selection-background-color': 'var(--highlight)',
  '--xy-selection-border': '1px dashed var(--ring)',
  '--xy-node-border-selected': '1px solid var(--ring)',
} as CSSProperties;

type Measured = { width: number; height: number };

const fitViewOptions = { padding: 0.25, maxZoom: 1 };
const snapGrid: [number, number] = [10, 10];

export function EditorCanvas({ state, runStates, automations }: Props) {
  const { document, selection, nodeIssues } = state;
  const [measured, setMeasured] = useState<Record<string, Measured>>({});
  const { fitView } = useReactFlow();
  const store = useStoreApi();
  const revealNode = (id: string) => {
    const { nodeLookup, transform, width, height } = store.getState();
    const node = nodeLookup.get(id);
    if (!node) return;
    const [offsetX, offsetY, zoom] = transform;
    const left = node.internals.positionAbsolute.x * zoom + offsetX;
    const top = node.internals.positionAbsolute.y * zoom + offsetY;
    const right = left + (node.measured.width ?? 0) * zoom;
    const bottom = top + (node.measured.height ?? 0) * zoom;
    if (left < 0 || top < 0 || right > width || bottom > height)
      void fitView(fitViewOptions);
  };
  const nodes = useMemo<EditorCanvasNode[]>(
    () => [
      {
        id: START_NODE_ID,
        type: 'start',
        position: { x: START_NODE_X, y: laneTop('plan') + LANE_TOP_PADDING_PX },
        data: { pipelineName: document.name, automations },
        measured: measured[START_NODE_ID],
        draggable: false,
        deletable: false,
        connectable: false,
        selected: selection.kind === 'start',
      },
      ...document.nodes.map<EditorCanvasNode>(node => ({
        id: node.id,
        type: 'step',
        position: node.position,
        data: {
          editor: node,
          issues: nodeIssues.get(node.id) ?? [],
          runState: runStates?.get(node.id) ?? null,
        },
        measured: measured[node.id],
        selected: selection.kind === 'node' && selection.id === node.id,
      })),
    ],
    [
      document.name,
      document.nodes,
      automations,
      selection,
      nodeIssues,
      runStates,
      measured,
    ],
  );
  const edges = useMemo<ConditionEdge[]>(
    () =>
      document.edges.map(edge => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: 'condition',
        data: { when: edge.when },
        selected: selection.kind === 'edge' && selection.id === edge.id,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: toneColor[edgeTones[edge.when]],
          width: 14,
          height: 14,
        },
      })),
    [document.edges, selection],
  );
  const onNodesChange = (changes: NodeChange<EditorCanvasNode>[]) => {
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) {
        const { id, dimensions } = change;
        if (!measured[id] && id !== START_NODE_ID) revealNode(id);
        setMeasured(current =>
          current[id]?.width === dimensions.width &&
          current[id]?.height === dimensions.height
            ? current
            : { ...current, [id]: dimensions },
        );
      } else if (change.type === 'position' && change.position) {
        if (change.id === START_NODE_ID) continue;
        if (change.dragging) state.moveNode(change.id, change.position);
        else state.settleNode(change.id, change.position);
      } else if (change.type === 'select' && change.selected) {
        state.select(
          change.id === START_NODE_ID
            ? { kind: 'start' }
            : { kind: 'node', id: change.id },
        );
      } else if (change.type === 'remove' && change.id !== START_NODE_ID) {
        state.removeNode(change.id);
      }
    }
  };
  const onEdgesChange = (changes: EdgeChange<ConditionEdge>[]) => {
    for (const change of changes) {
      if (change.type === 'select' && change.selected)
        state.select({ kind: 'edge', id: change.id });
      else if (change.type === 'remove') state.removeEdge(change.id);
    }
  };
  const onConnect: OnConnect = connection => {
    if (
      connection.source &&
      connection.target &&
      connection.source !== START_NODE_ID &&
      connection.target !== START_NODE_ID
    )
      state.connect(connection.source, connection.target);
  };
  return (
    <ReactFlow<EditorCanvasNode, ConditionEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => state.select({ kind: 'pipeline' })}
      fitView
      fitViewOptions={fitViewOptions}
      minZoom={0.25}
      maxZoom={2}
      panOnDrag={[0, 1, 2]}
      panActivationKeyCode="Space"
      selectionOnDrag={false}
      zoomOnDoubleClick={false}
      deleteKeyCode="Delete"
      snapToGrid
      snapGrid={snapGrid}
      multiSelectionKeyCode={null}
      connectionLineStyle={{ stroke: 'var(--muted-foreground)' }}
      proOptions={{ hideAttribution: true }}
      nodeDragThreshold={2}
      style={canvasVariables}
      className="bg-background text-foreground"
      aria-label="Pipeline graph canvas"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        color="var(--border)"
      />
      <Lanes />
    </ReactFlow>
  );
}
