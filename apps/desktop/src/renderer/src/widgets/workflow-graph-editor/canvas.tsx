import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
  useStoreApi,
  type EdgeChange,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import {
  edgeTones,
  firstStepPosition,
  startPosition,
  toneColor,
  type EdgeCondition,
} from '@/entities/workflow-graph';
import { CanvasControls } from './canvas-controls';
import {
  HOVER_LINGER_MS,
  PLACEHOLDER_NODE_ID,
  START_NODE_ID,
  edgeTypes,
  nodeTypes,
} from './canvas-types';
import type { ConditionEdge } from './edges';
import type { EditorCanvasNode, RunBadge } from './nodes';
import { PhaseFrames } from './phase-frames';
import type { AddOrigin, EditorState } from './use-editor-state';

type Props = {
  state: EditorState;
  runBadges: Map<string, RunBadge> | null;
  automations: number;
  assistantAdded: string[];
  onRequestAdd: (origin: AddOrigin, event: ReactMouseEvent) => void;
};

const canvasVariables = {
  '--xy-background-color': 'var(--background)',
  '--xy-edge-stroke': 'var(--border)',
  '--xy-edge-stroke-selected': 'var(--foreground)',
  '--xy-connectionline-stroke': 'var(--muted-foreground)',
  '--xy-selection-background-color': 'var(--highlight)',
  '--xy-selection-border': '1px dashed var(--ring)',
  '--xy-node-border-selected': 'none',
  '--xy-minimap-background-color': 'var(--card)',
  '--xy-minimap-mask-background-color': 'var(--overlay)',
  '--xy-minimap-node-background-color': 'var(--muted-foreground)',
  '--xy-minimap-node-stroke-color': 'transparent',
} as CSSProperties;

type Measured = { width: number; height: number };

const snapGrid: [number, number] = [10, 10];
const fitPadding = 48;
const minFitZoom = 0.75;

export function EditorCanvas({
  state,
  runBadges,
  automations,
  assistantAdded,
  onRequestAdd,
}: Props) {
  const { document, selection, nodeIssues } = state;
  const [measured, setMeasured] = useState<Record<string, Measured>>({});
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [minimap, setMinimap] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { getNodes, getNodesBounds, setCenter, setViewport } =
    useReactFlow<EditorCanvasNode>();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const initialized = useNodesInitialized();
  const initiallyFitted = useRef(false);
  const fitGraph = useCallback(() => {
    const bounds = getNodesBounds(getNodes());
    if (!bounds.width || !bounds.height || !width || !height) return;
    const fitZoom = Math.min(
      1,
      (width - fitPadding * 2) / bounds.width,
      (height - fitPadding * 2) / bounds.height,
    );
    if (fitZoom >= minFitZoom) {
      void setCenter(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        { zoom: fitZoom },
      );
    } else {
      void setViewport({
        x: fitPadding - bounds.x * minFitZoom,
        y: fitPadding - bounds.y * minFitZoom,
        zoom: minFitZoom,
      });
    }
  }, [getNodes, getNodesBounds, height, setCenter, setViewport, width]);
  useEffect(() => {
    if (!initialized || width <= 0 || height <= 0 || initiallyFitted.current)
      return;
    initiallyFitted.current = true;
    fitGraph();
  }, [fitGraph, height, initialized, width]);
  const store = useStoreApi();
  const hoverEdge = (id: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (id) setHoveredEdge(id);
    else
      hoverTimer.current = setTimeout(
        () => setHoveredEdge(null),
        HOVER_LINGER_MS,
      );
  };
  const revealNode = (id: string) => {
    const { nodeLookup, transform, width, height } = store.getState();
    const node = nodeLookup.get(id);
    if (!node) return;
    const [offsetX, offsetY, zoom] = transform;
    const { x, y } = node.internals.positionAbsolute;
    const nodeWidth = node.measured.width ?? 0;
    const nodeHeight = node.measured.height ?? 0;
    const left = x * zoom + offsetX;
    const top = y * zoom + offsetY;
    const right = left + nodeWidth * zoom;
    const bottom = top + nodeHeight * zoom;
    if (left < 0 || top < 0 || right > width || bottom > height)
      void setCenter(x + nodeWidth / 2, y + nodeHeight / 2, { zoom });
  };
  const outgoing = useMemo(() => {
    const map = new Map<string, Set<EdgeCondition>>();
    for (const edge of document.edges) {
      const set = map.get(edge.from) ?? new Set<EdgeCondition>();
      set.add(edge.when);
      map.set(edge.from, set);
    }
    return map;
  }, [document.edges]);
  const nodes = useMemo<EditorCanvasNode[]>(() => {
    const start = startPosition(document.nodes);
    const list: EditorCanvasNode[] = [
      {
        id: START_NODE_ID,
        type: 'start',
        position: start,
        data: {
          workflowName: document.name,
          automations,
          onAdd: event => onRequestAdd({ kind: 'start' }, event),
        },
        measured: measured[START_NODE_ID],
        draggable: false,
        deletable: false,
        connectable: false,
        selected: selection.kind === 'start',
      },
    ];
    if (document.nodes.length === 0)
      list.push({
        id: PLACEHOLDER_NODE_ID,
        type: 'placeholder',
        position: firstStepPosition(),
        data: { onAdd: event => onRequestAdd({ kind: 'start' }, event) },
        draggable: false,
        deletable: false,
        connectable: false,
      });
    for (const node of document.nodes) {
      const used = outgoing.get(node.id);
      list.push({
        id: node.id,
        type: 'step',
        position: node.position,
        data: {
          editor: node,
          issues: nodeIssues.get(node.id) ?? [],
          run: runBadges?.get(node.id) ?? null,
          addedByAssistant: assistantAdded.includes(node.id),
          freeSuccess: !used?.has('success') && !used?.has('any'),
          freeFailure: !used?.has('failure') && !used?.has('any'),
          onAdd: (when, event) =>
            onRequestAdd({ kind: 'after', id: node.id, when }, event),
          onDelete: () => state.removeNode(node.id),
          onDuplicate: () => state.duplicateNode(node.id),
        },
        measured: measured[node.id],
        selected: selection.kind === 'node' && selection.id === node.id,
      });
    }
    return list;
  }, [
    document.name,
    document.nodes,
    automations,
    selection,
    nodeIssues,
    runBadges,
    assistantAdded,
    measured,
    outgoing,
    onRequestAdd,
    state,
  ]);
  const edges = useMemo<ConditionEdge[]>(
    () =>
      document.edges.map(edge => ({
        id: edge.id,
        source: edge.from,
        sourceHandle: edge.when === 'failure' ? 'failure' : 'success',
        target: edge.to,
        targetHandle: 'in',
        type: 'condition',
        data: {
          when: edge.when,
          predicate: edge.predicate,
          hovered: hoveredEdge === edge.id,
          onHover: hovering => hoverEdge(hovering ? edge.id : null),
          onInsert: event => onRequestAdd({ kind: 'edge', id: edge.id }, event),
          onDelete: () => state.removeEdge(edge.id),
        },
        selected: selection.kind === 'edge' && selection.id === edge.id,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: toneColor[edgeTones[edge.when]],
          width: 14,
          height: 14,
        },
      })),
    [document.edges, selection, hoveredEdge, onRequestAdd, state],
  );
  const onNodesChange = (changes: NodeChange<EditorCanvasNode>[]) => {
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) {
        const { id, dimensions } = change;
        if (id === state.revealId) {
          revealNode(id);
          state.clearReveal();
        }
        setMeasured(current =>
          current[id]?.width === dimensions.width &&
          current[id]?.height === dimensions.height
            ? current
            : { ...current, [id]: dimensions },
        );
      } else if (change.type === 'position' && change.position) {
        if (change.id === START_NODE_ID || change.id === PLACEHOLDER_NODE_ID)
          continue;
        if (change.dragging) state.moveNode(change.id, change.position);
        else state.settleNode(change.id, change.position);
      } else if (change.type === 'select' && change.selected) {
        if (change.id === PLACEHOLDER_NODE_ID) continue;
        state.select(
          change.id === START_NODE_ID
            ? { kind: 'start' }
            : { kind: 'node', id: change.id },
        );
      } else if (
        change.type === 'remove' &&
        change.id !== START_NODE_ID &&
        change.id !== PLACEHOLDER_NODE_ID
      ) {
        const { id } = change;
        setMeasured(current => {
          if (!current[id]) return current;
          const rest = { ...current };
          delete rest[id];
          return rest;
        });
        state.removeNode(id);
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
      connection.target !== START_NODE_ID &&
      connection.target !== PLACEHOLDER_NODE_ID
    )
      state.connect(
        connection.source,
        connection.target,
        connection.sourceHandle === 'failure' ? 'failure' : 'success',
      );
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
      onEdgeMouseEnter={(_, edge) => hoverEdge(edge.id)}
      onEdgeMouseLeave={() => hoverEdge(null)}
      onPaneClick={() => state.select({ kind: 'none' })}
      minZoom={0.15}
      maxZoom={2}
      panOnDrag={[0, 1, 2]}
      panActivationKeyCode="Space"
      selectionOnDrag={false}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      snapToGrid
      snapGrid={snapGrid}
      multiSelectionKeyCode={null}
      connectionLineStyle={{ stroke: 'var(--muted-foreground)' }}
      proOptions={{ hideAttribution: true }}
      nodeDragThreshold={2}
      style={canvasVariables}
      className="bg-background text-foreground"
      aria-label="Workflow graph canvas"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={24}
        size={1.2}
        color="var(--border)"
      />
      <PhaseFrames nodes={document.nodes} />
      {minimap && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          className="!m-3 !mb-16 rounded-surface border shadow-(--popover-shadow)"
          nodeColor={node =>
            node.type === 'start' ? 'var(--primary)' : 'var(--muted-foreground)'
          }
          nodeBorderRadius={8}
          aria-label="Minimap"
        />
      )}
      <CanvasControls
        onFit={fitGraph}
        minimap={minimap}
        onToggleMinimap={() => setMinimap(value => !value)}
        onTidy={state.autoLayoutAll}
        tidyDisabled={document.nodes.length === 0}
      />
    </ReactFlow>
  );
}
