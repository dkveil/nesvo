import * as React from 'react';
import { cn } from '@/shared/lib/cn';
import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-(--overlay) backdrop-blur-[2px] duration-base data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  placement = 'center',
  surface = 'card',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  placement?: 'center' | 'top' | 'fullscreen';
  surface?: 'card' | 'panel';
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-placement={placement}
        data-surface={surface}
        className={cn(
          'fixed left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] gap-4 rounded-overlay border p-6 shadow-(--dialog-shadow) duration-slow ease-out outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] sm:max-w-lg',
          surface === 'card' && 'bg-card',
          surface === 'panel' &&
            'border-info-panel-border bg-info-panel text-card-foreground',
          placement === 'center' && 'top-[50%] translate-y-[-50%]',
          placement === 'top' && 'top-[12vh]',
          placement === 'fullscreen' &&
            'inset-3 flex w-auto max-w-none translate-x-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <IconButton
              data-slot="dialog-close"
              label="Close"
              tooltip={false}
              className="absolute top-3 right-3"
            >
              <XIcon />
            </IconButton>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-1 text-left', className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <DialogCancel>Close</DialogCancel>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogCancel({
  children = 'Cancel',
  type = 'button',
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <Button
      data-slot="dialog-cancel"
      type={type}
      variant="ghost"
      size="lg"
      {...props}
    >
      {children}
    </Button>
  );
}

function DialogTitle({
  className,
  size = 'md',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & {
  size?: 'sm' | 'md';
}) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        'font-semibold',
        size === 'sm' ? 'text-sm leading-5' : 'text-base leading-6',
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-xs leading-5 text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogCancel,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
