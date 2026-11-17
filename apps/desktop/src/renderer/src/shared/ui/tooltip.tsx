import type { ComponentProps } from 'react';
import { cn } from 'cn';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

function TooltipProvider({
  delayDuration = 350,
  skipDelayDuration = 250,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(
  props: ComponentProps<typeof TooltipPrimitive.Trigger>,
) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

type TooltipContentProps = ComponentProps<typeof TooltipPrimitive.Content> & {
  shortcut?: string;
};

function TooltipContent({
  className,
  sideOffset = 8,
  collisionPadding = 8,
  shortcut,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'glass-popover z-50 flex origin-(--radix-tooltip-content-transform-origin) items-center gap-2 rounded-md border px-2 py-1 text-xs font-medium text-popover-foreground select-none',
          'animate-in duration-150 ease-out fade-in-0 zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
          'data-[state=instant-open]:duration-75',
          'data-[state=closed]:animate-out data-[state=closed]:duration-100 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        {shortcut && (
          <kbd className="rounded-sm bg-kbd px-1 py-px font-sans text-2xs leading-4 text-muted-foreground">
            {shortcut}
          </kbd>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
