import type { KeyboardEvent, PointerEvent } from 'react';
import {
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  sidebarMaxWidth,
} from './sidebar-width';

const KEYBOARD_STEP_PX = 16;

type Props = {
  width: number;
  onResize: (width: number) => void;
};

export function SidebarResizer({ width, onResize }: Props) {
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    const move = (next: globalThis.PointerEvent) =>
      onResize(startWidth + next.clientX - startX);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      document.body.style.removeProperty('cursor');
    };
    document.body.style.cursor = 'col-resize';
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? width - KEYBOARD_STEP_PX
        : event.key === 'ArrowRight'
          ? width + KEYBOARD_STEP_PX
          : event.key === 'Home'
            ? SIDEBAR_MIN_WIDTH_PX
            : event.key === 'End'
              ? sidebarMaxWidth()
              : null;
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH_PX}
      aria-valuemax={sidebarMaxWidth()}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_WIDTH_PX)}
      className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-ring/60 group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
}
