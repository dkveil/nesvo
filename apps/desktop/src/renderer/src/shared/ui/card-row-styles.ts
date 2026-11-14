import { cn } from 'cn';

export const cardRow =
  'flex h-7 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium text-foreground';

export const cardRowAction = cn(
  cardRow,
  'group/row transition-colors duration-100 outline-none enabled:hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50',
);

export const cardSection = 'px-1.5 py-1.5';

export const cardSectionHeader =
  'flex h-7 items-center justify-between gap-2 px-2.5 text-2xs text-muted-foreground';

export const cardIcon = 'size-4 shrink-0 text-muted-foreground';

export const cardValue =
  'shrink-0 text-xs font-normal text-muted-foreground tabular-nums';

export const cardIconButton =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 outline-none enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:bg-accent aria-expanded:text-foreground';

export const cardSurface =
  'rounded-xl border border-(--popover-border) bg-card text-card-foreground';
