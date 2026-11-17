import { useState, type DragEvent } from 'react';
import type { DragItem, DropPlacement } from './housekeeping';

const DRAG_TYPE = 'application/x-nesvo-sidebar';

type DropTarget = { key: string; placement: DropPlacement };

const placementAt = (
  event: DragEvent<HTMLElement>,
  allowed: DropPlacement[],
): DropPlacement | null => {
  const box = event.currentTarget.getBoundingClientRect();
  const ratio = box.height > 0 ? (event.clientY - box.top) / box.height : 0.5;
  if (allowed.includes('into')) {
    const edges = allowed.length > 1 ? 0.25 : 0;
    if (ratio >= edges && ratio <= 1 - edges) return 'into';
  }
  const edge = ratio < 0.5 ? 'before' : 'after';
  if (allowed.includes(edge)) return edge;
  return allowed[0] ?? null;
};

export type DropZone = {
  key: string;
  accepts: (item: DragItem) => DropPlacement[];
  onDrop: (item: DragItem, placement: DropPlacement) => void;
};

export function useSidebarDrag(enabled: boolean) {
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const reset = () => {
    setDragging(null);
    setTarget(null);
  };
  const source = (item: DragItem) =>
    enabled
      ? {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLElement>) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(DRAG_TYPE, item.id);
            setDragging(item);
          },
          onDragEnd: reset,
        }
      : {};
  const zone = ({ key, accepts, onDrop }: DropZone) =>
    enabled
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!dragging) return;
            const placement = placementAt(event, accepts(dragging));
            if (!placement) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            if (target?.key !== key || target.placement !== placement)
              setTarget({ key, placement });
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            if (event.currentTarget.contains(event.relatedTarget as Node))
              return;
            setTarget(previous => (previous?.key === key ? null : previous));
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            if (!dragging) return;
            const placement = placementAt(event, accepts(dragging));
            if (!placement) return;
            event.preventDefault();
            event.stopPropagation();
            const item = dragging;
            reset();
            onDrop(item, placement);
          },
        }
      : {};
  const indicator = (key: string) =>
    target?.key === key ? target.placement : null;
  return { dragging, source, zone, indicator };
}
