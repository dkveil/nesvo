import { useEffect, type ComponentProps, type ReactNode } from 'react';
import { cn } from 'cn';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { KeyCombo } from '@/shared/ui/kbd';

const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'F6',
]);
const KEYBOARD_FOCUS_WINDOW_MS = 120;
const keyboardNavigation = { at: Number.NEGATIVE_INFINITY, listeners: 0 };

const recordNavigationKey = (event: KeyboardEvent) => {
  if (NAVIGATION_KEYS.has(event.key)) keyboardNavigation.at = performance.now();
};

const focusCameFromKeyboard = (target: Element) =>
  target.matches(':focus-visible') &&
  performance.now() - keyboardNavigation.at < KEYBOARD_FOCUS_WINDOW_MS;

function TooltipProvider({
  delayDuration = 350,
  skipDelayDuration = 250,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  useEffect(() => {
    if (keyboardNavigation.listeners++ === 0)
      document.addEventListener('keydown', recordNavigationKey, true);
    return () => {
      if (--keyboardNavigation.listeners === 0)
        document.removeEventListener('keydown', recordNavigationKey, true);
    };
  }, []);
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

function TooltipTrigger({
  onFocus,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={event => {
        onFocus?.(event);
        if (!focusCameFromKeyboard(event.currentTarget)) event.preventDefault();
      }}
      {...props}
    />
  );
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
          'animate-in duration-base ease-out fade-in-0 zoom-in-[0.97]',
          'data-[side=bottom]:slide-in-from-top-0.5 data-[side=left]:slide-in-from-right-0.5 data-[side=right]:slide-in-from-left-0.5 data-[side=top]:slide-in-from-bottom-0.5',
          'data-[state=instant-open]:duration-fast',
          'data-[state=closed]:animate-out data-[state=closed]:duration-fast data-[state=closed]:fade-out-0',
          variant === 'label' && [
            'flex h-6 items-center gap-2 rounded-[7px] bg-tooltip pr-1 pl-2 text-2xs leading-none font-medium text-tooltip-foreground shadow-(--tooltip-shadow) select-none',
            !shortcut && 'pr-2',
          ],
          variant === 'panel' &&
            'glass-popover max-w-72 rounded-surface border px-3 py-2 text-xs text-popover-foreground',
          className,
        )}
        {...props}
      >
        {children}
        {shortcut && <KeyCombo keys={shortcut} tone="tooltip" />}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

type HintProps = {
  label: ReactNode;
  shortcut?: string;
  side?: TooltipContentProps['side'];
  align?: TooltipContentProps['align'];
  disabled?: boolean;
  children: ReactNode;
};

function Hint({
  label,
  shortcut,
  side,
  align,
  disabled = false,
  children,
}: HintProps) {
  if (disabled || !label) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} shortcut={shortcut}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
