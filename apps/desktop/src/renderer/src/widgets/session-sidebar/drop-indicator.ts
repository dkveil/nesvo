import { cn } from 'cn';
import type { DropPlacement } from './housekeeping';

export const dropIndicatorClass = (
  placement: DropPlacement | null | undefined,
) =>
  cn(
    placement === 'before' &&
      'before:absolute before:inset-x-1 before:-top-px before:z-10 before:h-0.5 before:rounded-full before:bg-ring',
    placement === 'after' &&
      'after:absolute after:inset-x-1 after:-bottom-px after:z-10 after:h-0.5 after:rounded-full after:bg-ring',
    placement === 'into' && 'rounded-md ring-1 ring-ring ring-inset',
  );
