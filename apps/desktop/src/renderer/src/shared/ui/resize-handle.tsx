import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { cn } from '@/shared/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

type ResizeOffset = { x: number; y: number };

type ResizeEdge = 'left' | 'right';

type ResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

type ResizeHandleProps = Omit<
  ComponentProps<'div'>,
  'role' | 'aria-label' | 'onResize'
> & {
  label: string;
  hint?: string;
  onResizeStart?: () => void;
  onResize: (offset: ResizeOffset) => void;
  onResizeEnd?: () => void;
  onStep?: (direction: ResizeOffset) => void;
} & (
    | { variant?: 'edge'; edge?: ResizeEdge; corner?: never }
    | { variant: 'corner'; corner?: ResizeCorner; edge?: never }
  );

const ARROW_DIRECTIONS: Record<string, ResizeOffset> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

const edgeClasses: Record<ResizeEdge, string> = {
  left: '-left-1',
  right: '-right-1',
};

const cornerClasses: Record<ResizeCorner, string> = {
  'top-left': 'top-0 left-0 cursor-nwse-resize rounded-tl-overlay',
  'top-right': 'top-0 right-0 cursor-nesw-resize rounded-tr-overlay',
  'bottom-left': 'bottom-0 left-0 cursor-nesw-resize rounded-bl-overlay',
  'bottom-right': 'right-0 bottom-0 cursor-nwse-resize rounded-br-overlay',
};

const cornerCursors: Record<ResizeCorner, string> = {
  'top-left': 'nwse-resize',
  'top-right': 'nesw-resize',
  'bottom-left': 'nesw-resize',
  'bottom-right': 'nwse-resize',
};

export function ResizeHandle({
  label,
  hint,
  variant = 'edge',
  edge = 'left',
  corner = 'top-left',
  onResizeStart,
  onResize,
  onResizeEnd,
  onStep,
  onPointerDown,
  onKeyDown,
  className,
  ...props
}: ResizeHandleProps) {
  const isCorner = variant === 'corner';
  const [dragging, setDragging] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    const handle = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY };
    handle.setPointerCapture(event.pointerId);
    const move = (next: globalThis.PointerEvent) =>
      onResize({ x: next.clientX - start.x, y: next.clientY - start.y });
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      handle.removeEventListener('lostpointercapture', stop);
      document.body.style.removeProperty('cursor');
      stopDrag.current = null;
      setDragging(false);
      onResizeEnd?.();
    };
    stopDrag.current = stop;
    document.body.style.cursor = isCorner
      ? cornerCursors[corner]
      : 'col-resize';
    setDragging(true);
    setHintOpen(false);
    onResizeStart?.();
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('lostpointercapture', stop);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !onStep) return;
    const direction = ARROW_DIRECTIONS[event.key];
    if (!direction || (!isCorner && direction.x === 0)) return;
    event.preventDefault();
    onStep(direction);
  };
  const handle = (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={isCorner ? undefined : 'vertical'}
      tabIndex={0}
      data-slot="resize-handle"
      data-variant={variant}
      onPointerDown={startDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        'group z-20 touch-none',
        isCorner
          ? ['focus-ring absolute size-4', cornerClasses[corner]]
          : [
              'absolute inset-y-0 w-2 cursor-col-resize outline-none',
              edgeClasses[edge],
            ],
        className,
      )}
      {...props}
    >
      {!isCorner && (
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-fast ease-out group-hover:bg-ring/60 group-focus-visible:bg-ring group-active:bg-ring group-data-preview-focus:bg-ring group-data-preview-hover:bg-ring/60" />
      )}
    </div>
  );
  if (!hint) return handle;
  return (
    <Tooltip open={hintOpen && !dragging} onOpenChange={setHintOpen}>
      <TooltipTrigger asChild>{handle}</TooltipTrigger>
      <TooltipContent side={isCorner ? 'left' : undefined}>
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

export type { ResizeOffset };
