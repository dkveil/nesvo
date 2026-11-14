import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import {
  edgeTones,
  edgeWhenLabels,
  toneColor,
  type EdgeCondition,
} from '@/entities/pipeline-graph';

export type ConditionEdgeData = { when: EdgeCondition };
export type ConditionEdge = Edge<ConditionEdgeData, 'condition'>;

export function ConditionEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
  markerEnd,
}: EdgeProps<ConditionEdge>) {
  const when = data?.when ?? 'success';
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const color = selected ? 'var(--foreground)' : toneColor[edgeTones[when]];
  return (
    <>
      <BaseEdge
        id={id}
        data-editor-edge={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{ stroke: color, strokeWidth: selected ? 2 : 1.5 }}
      />
      {when !== 'success' && (
        <EdgeLabelRenderer>
          <span
            data-editor-edge-label={id}
            className="pointer-events-none absolute rounded-full border bg-card px-1.5 text-2xs leading-4 font-medium"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color,
              borderColor: color,
            }}
          >
            {edgeWhenLabels[when]}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
