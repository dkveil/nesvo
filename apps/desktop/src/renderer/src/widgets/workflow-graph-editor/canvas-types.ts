import type { EdgeTypes, NodeTypes } from '@xyflow/react';
import { ConditionEdgeView } from './edges';
import { StartNodeView, StepNodeView } from './nodes';

export const START_NODE_ID = '__start';

export const nodeTypes: NodeTypes = {
  step: StepNodeView,
  start: StartNodeView,
};

export const edgeTypes: EdgeTypes = {
  condition: ConditionEdgeView,
};
