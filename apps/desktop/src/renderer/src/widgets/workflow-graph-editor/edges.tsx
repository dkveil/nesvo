import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';
import {
  edgeTones,
  edgeWhenLabels,
  toneColor,
  type EdgeCondition,
} from '@/entities/workflow-graph';

export type ConditionEdgeData = {
  when: EdgeCondition;
  predicate?: string | undefined;
  hovered?: boolean;
  onHover?: (hovering: boolean) => void;
  onInsert?: (event: ReactMouseEvent) => void;
  onDelete?: () => void;
};
export type ConditionEdge = Edge<ConditionEdgeData, 'condition'>;

const action = 'border bg-card shadow-xs';

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
          onMouseEnter={() => data?.onHover?.(true)}
          onMouseLeave={() => data?.onHover?.(false)}
        >
          {active && data?.onInsert && (
            <div
              role="toolbar"
              aria-label={`Connection ${id}`}
              data-editor-edge-actions={id}
              className="nodrag nopan pointer-events-auto flex items-center gap-1"
            >
              <IconButton
                size={24}
                shape="round"
                data-edge-insert={id}
                label={`Insert a step into ${id}`}
                className={cn(action, 'enabled:hover:border-foreground')}
                onClick={event => {
                  event.stopPropagation();
                  data.onInsert?.(event);
                }}
              >
                <Plus aria-hidden="true" />
              </IconButton>
              <IconButton
                size={24}
                shape="round"
                tone="danger"
                data-edge-delete={id}
                label={`Remove connection ${id}`}
                className={cn(action, 'enabled:hover:border-error-foreground')}
                onClick={event => {
                  event.stopPropagation();
                  data.onDelete?.();
                }}
              >
                <Trash2 aria-hidden="true" />
              </IconButton>
            </div>
          )}
          {(when !== 'success' || data?.predicate) && (
            <span
              data-editor-edge-label={id}
              className="pointer-events-none rounded-full border bg-card px-1.5 text-2xs leading-4 font-medium whitespace-nowrap"
              style={{ color, borderColor: color }}
            >
              {data?.predicate
                ? `When ${data.predicate}`
                : edgeWhenLabels[when]}
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
