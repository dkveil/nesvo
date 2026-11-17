import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { PanelResizerProps as ResizerState } from '@/shared/lib/use-panel-width';

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
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    const move = (next: globalThis.PointerEvent) =>
      onResize(startWidth - (next.clientX - startX));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      handle.removeEventListener('lostpointercapture', stop);
      document.body.style.removeProperty('cursor');
      stopDrag.current = null;
      onDraggingChange(false);
    };
    stopDrag.current = stop;
    document.body.style.cursor = 'col-resize';
    onDraggingChange(true);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('lostpointercapture', stop);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? width + KEYBOARD_STEP_PX
        : event.key === 'ArrowRight'
          ? width - KEYBOARD_STEP_PX
          : event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className="group absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize outline-none min-[1200px]:block"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 ease-out group-hover:bg-ring/60 group-focus-visible:bg-ring group-active:bg-ring motion-reduce:transition-none" />
    </div>
  );
}
