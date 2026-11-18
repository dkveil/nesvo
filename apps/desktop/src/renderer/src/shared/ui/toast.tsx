import type { ComponentProps, ReactNode } from 'react';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { Spinner } from '@/shared/ui/spinner';

type ToastTone = 'info' | 'success' | 'error' | 'loading';

type ToastAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

type ToastRegionProps = ComponentProps<'section'> & {
  label?: string;
};

type ToastProps = Omit<ComponentProps<'div'>, 'title'> & {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ToastAction;
  onDismiss?: () => void;
  dismissLabel?: string;
  preview?: boolean;
};

const icons = {
  info: Info,
  success: CircleCheck,
  error: CircleX,
} as const;

const iconTone: Record<ToastTone, string> = {
  info: 'text-muted-foreground',
  loading: 'text-muted-foreground',
  success: 'text-success-foreground',
  error: 'text-error-foreground',
};

export function ToastRegion({
  label = 'Notifications',
  className,
  ...props
}: ToastRegionProps) {
  return (
    <section
      data-slot="toast-region"
      aria-label={label}
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4',
        className,
      )}
      {...props}
    />
  );
}

export function Toast({
  tone = 'info',
  title,
  description,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  preview = false,
  className,
  ...props
}: ToastProps) {
  const Icon = tone === 'loading' ? null : icons[tone];
  return (
    <div
      data-slot="toast"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={cn(
        'pointer-events-auto flex w-full max-w-sm min-w-0 items-center gap-2 rounded-surface border py-1.5 pr-1.5 pl-3 text-ui glass-popover',
        !preview &&
          'duration-base ease-out animate-in fade-in-0 slide-in-from-bottom-2',
        className,
      )}
      {...props}
    >
      {tone === 'loading' && <Spinner className="shrink-0" />}
      {Icon && (
        <Icon
          aria-hidden="true"
          className={cn('size-4 shrink-0', iconTone[tone])}
        />
      )}
      <div className="min-w-0 flex-1 py-0.5">
        <p className="truncate text-foreground">{title}</p>
        {description && (
          <p className="truncate text-2xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 font-medium"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
      {onDismiss && (
        <IconButton
          label={dismissLabel}
          size={24}
          className="shrink-0"
          onClick={onDismiss}
        >
          <X />
        </IconButton>
      )}
    </div>
  );
}
