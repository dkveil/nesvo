import { useRef, type KeyboardEvent } from 'react';
import { ResizeHandle } from '@/shared/ui/resize-handle';
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
  const startWidth = useRef(width);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'Home'
        ? SIDEBAR_MIN_WIDTH_PX
        : event.key === 'End'
          ? sidebarMaxWidth()
          : null;
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };
  return (
    <ResizeHandle
      label="Resize sidebar"
      hint="Drag to resize, double-click to reset"
      edge="right"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH_PX}
      aria-valuemax={sidebarMaxWidth()}
      onResizeStart={() => {
        startWidth.current = width;
      }}
      onResize={offset => onResize(startWidth.current + offset.x)}
      onStep={direction => onResize(width + direction.x * KEYBOARD_STEP_PX)}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_WIDTH_PX)}
    />
  );
}
