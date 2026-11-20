import type { EdgeTypes, NodeTypes } from '@xyflow/react';
import { ConditionEdgeView } from './edges';
import { PlaceholderNodeView, StartNodeView, StepNodeView } from './nodes';

export const START_NODE_ID = '__start';
export const HOVER_LINGER_MS = 160;
export const fitViewOptions = { padding: 0.12, minZoom: 0.75, maxZoom: 1 };
export const PLACEHOLDER_NODE_ID = '__add-first';

export const nodeTypes: NodeTypes = {
  step: StepNodeView,
  start: StartNodeView,
  placeholder: PlaceholderNodeView,
};

export const edgeTypes: EdgeTypes = {
  condition: ConditionEdgeView,
};
