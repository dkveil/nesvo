export const menuSurface =
  'z-50 overflow-x-hidden overflow-y-auto rounded-surface border border-(--popover-border) bg-popover p-1 text-popover-foreground shadow-(--popover-shadow) duration-base ease-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97]';

export const menuItem =
  "focus-ring relative flex h-7 w-full min-w-0 cursor-default items-center gap-2 rounded-control px-2 text-left text-ui text-popover-foreground transition-colors duration-fast select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground";

export const menuItemDestructive =
  'text-destructive data-highlighted:text-destructive [&_svg:not([class*=text-])]:text-destructive';

export const menuLabel =
  'flex h-6 items-center px-2 text-2xs font-medium text-muted-foreground';

export const menuSeparator = '-mx-1 my-1 h-px bg-border';

export const menuShortcut =
  'ml-auto pl-4 text-2xs tracking-wide text-muted-foreground';
