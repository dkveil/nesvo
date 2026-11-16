import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import {
  edgeTones,
  edgeWhenLabels,
  toneColor,
  type EdgeCondition,
} from '@/entities/workflow-graph';

export type ConditionEdgeData = {
  when: EdgeCondition;
  hovered: boolean;
  onHover: (hovering: boolean) => void;
  onInsert: (event: ReactMouseEvent) => void;
  onDelete: () => void;
};
export type ConditionEdge = Edge<ConditionEdgeData, 'condition'>;

const action =
  'flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-xs transition-[color,border-color,transform] duration-100 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring enabled:active:scale-95 [&_svg]:size-3.5';

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
  const hovered = data?.hovered ?? false;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const color = selected ? 'var(--foreground)' : toneColor[edgeTones[when]];
  const active = hovered || selected;
  return (
    <>
      <BaseEdge
        id={id}
        data-editor-edge={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={20}
        style={{
          stroke: color,
          strokeWidth: active ? 2 : 1.5,
          strokeDasharray: when === 'any' ? '6 4' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
          style={{ left: labelX, top: labelY }}
          onMouseEnter={() => data?.onHover(true)}
          onMouseLeave={() => data?.onHover(false)}
        >
          {active && (
            <div
              role="toolbar"
              aria-label={`Connection ${id}`}
              data-editor-edge-actions={id}
              className="nodrag nopan pointer-events-auto flex items-center gap-1"
            >
              <button
                type="button"
                data-edge-insert={id}
                aria-label={`Insert a step into ${id}`}
                title="Insert a step here"
                className={cn(action, 'hover:border-foreground')}
                onClick={event => {
                  event.stopPropagation();
                  data?.onInsert(event);
                }}
              >
                <Plus aria-hidden="true" />
              </button>
              <button
                type="button"
                data-edge-delete={id}
                aria-label={`Remove connection ${id}`}
                title="Remove connection"
                className={cn(
                  action,
                  'hover:border-error-foreground hover:text-error-foreground',
                )}
                onClick={event => {
                  event.stopPropagation();
                  data?.onDelete();
                }}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          )}
          {when !== 'success' && (
            <span
              data-editor-edge-label={id}
              className="pointer-events-none rounded-full border bg-card px-1.5 text-2xs leading-4 font-medium whitespace-nowrap"
              style={{ color, borderColor: color }}
            >
              {edgeWhenLabels[when]}
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
