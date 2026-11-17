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
  variant?: 'label' | 'panel';
  shortcut?: string;
};

function TooltipContent({
  className,
  variant = 'label',
  sideOffset = 10,
  collisionPadding = 8,
  shortcut,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-variant={variant}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 origin-(--radix-tooltip-content-transform-origin)',
          'animate-in duration-150 ease-out fade-in-0 zoom-in-[0.97]',
          'data-[side=bottom]:slide-in-from-top-0.5 data-[side=left]:slide-in-from-right-0.5 data-[side=right]:slide-in-from-left-0.5 data-[side=top]:slide-in-from-bottom-0.5',
          'data-[state=instant-open]:duration-75',
          'data-[state=closed]:animate-out data-[state=closed]:duration-100 data-[state=closed]:fade-out-0',
          variant === 'label' && [
            'flex h-6 items-center gap-2 rounded-[7px] bg-tooltip pr-1 pl-2 text-2xs leading-none font-medium text-tooltip-foreground shadow-(--tooltip-shadow) select-none',
            !shortcut && 'pr-2',
          ],
          variant === 'panel' &&
            'glass-popover rounded-lg border px-3 py-2 text-xs text-popover-foreground',
          className,
        )}
        {...props}
      >
        {children}
        {shortcut && (
          <span aria-hidden="true" className="flex items-center gap-0.5">
            {shortcut.split(' ').map(key => (
              <kbd
                key={key}
                className="flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-tooltip-key px-1 font-sans text-[10px] leading-none font-medium text-tooltip-foreground/70"
              >
                {key}
              </kbd>
            ))}
          </span>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
