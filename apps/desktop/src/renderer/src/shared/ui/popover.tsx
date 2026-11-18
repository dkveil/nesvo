import * as React from 'react';
import { cn } from '@/shared/lib/cn';
import { Popover as PopoverPrimitive } from 'radix-ui';

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

type PopoverSurface = 'glass' | 'solid' | 'card' | 'panel';
type PopoverSize = 'default' | 'auto' | 'sm' | 'md' | 'lg' | 'trigger';

type PopoverContentProps = React.ComponentProps<
  typeof PopoverPrimitive.Content
> & {
  surface?: PopoverSurface;
  size?: PopoverSize;
  padding?: 'none' | 'sm' | 'md';
  scroll?: boolean;
};

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  collisionPadding = 8,
  surface = 'glass',
  size = 'default',
  padding = 'md',
  scroll = false,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-surface={surface}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 origin-(--radix-popover-content-transform-origin) rounded-surface border text-popover-foreground outline-hidden duration-base ease-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97]',
          surface === 'glass' && 'glass-popover',
          surface === 'solid' &&
            'border-(--popover-border) bg-popover shadow-(--popover-shadow)',
          surface === 'card' &&
            'border-(--popover-border) bg-card text-card-foreground shadow-(--popover-shadow)',
          surface === 'panel' &&
            'border-info-panel-border bg-info-panel text-card-foreground shadow-(--popover-shadow)',
          size === 'default' && 'w-72',
          size === 'sm' && 'w-[min(15rem,calc(100vw-1rem))]',
          size === 'md' && 'w-[min(20rem,calc(100vw-1rem))]',
          size === 'lg' && 'w-[min(26rem,calc(100vw-1rem))]',
          size === 'trigger' && 'w-(--radix-popover-trigger-width)',
          scroll &&
            'max-h-[min(28rem,var(--radix-popover-content-available-height))] overflow-y-auto',
          padding === 'md' && 'p-4',
          padding === 'sm' && 'p-1',
          padding === 'none' && 'p-0',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
