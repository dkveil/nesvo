import type { DropPlacement } from './housekeeping';

export const toDropIndicator = (placement: DropPlacement | null | undefined) =>
  placement === 'into' ? 'inside' : (placement ?? null);
