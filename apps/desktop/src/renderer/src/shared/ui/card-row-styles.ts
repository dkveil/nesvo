import { cn } from '@/shared/lib/cn';

export const cardRow =
  'flex h-6.75 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-ui font-medium text-foreground';

export const cardRowAction = cn(
  cardRow,
  'focus-ring group/row transition-colors duration-fast enabled:hover:bg-accent data-selected:bg-highlight disabled:cursor-not-allowed disabled:opacity-50',
);

export const cardSection = 'px-1.5 py-1.5';

export const cardSectionHeader =
  'flex h-6.75 items-center justify-between gap-2 px-2.5 text-2xs text-muted-foreground';

export const cardIcon = 'size-4 shrink-0 text-muted-foreground';

export const cardValue =
  'shrink-0 text-xs font-normal text-muted-foreground tabular-nums';

export const cardIconButton =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground focus-ring transition-colors duration-fast enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:bg-accent aria-expanded:text-foreground';

export const cardSurface =
  'rounded-overlay border border-(--popover-border) bg-card text-card-foreground';

export const infoPanelSurface =
  'rounded-overlay border border-info-panel-border bg-info-panel text-card-foreground';

export const fieldSurface =
  'rounded-overlay border border-input bg-transparent text-card-foreground dark:bg-input/30';
