import { useRef, type KeyboardEvent } from 'react';
import type { PanelResizerProps as ResizerState } from '@/shared/lib/use-panel-width';
import { ResizeHandle } from '@/shared/ui/resize-handle';

const KEYBOARD_STEP_PX = 16;

type PanelResizerProps = ResizerState & { label: string };

export function PanelResizer({
  label,
  width,
  min,
  max,
  onResize,
  onReset,
  onDraggingChange,
}: PanelResizerProps) {
  const startWidth = useRef(width);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'Home' ? min : event.key === 'End' ? max : null;
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };
  return (
    <ResizeHandle
      label={label}
      hint="Drag to resize, double-click to reset"
      edge="left"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      onResizeStart={() => {
        startWidth.current = width;
        onDraggingChange(true);
      }}
      onResize={offset => onResize(startWidth.current - offset.x)}
      onResizeEnd={() => onDraggingChange(false)}
      onStep={direction => onResize(width - direction.x * KEYBOARD_STEP_PX)}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className="hidden min-[1200px]:block"
    />
  );
}
