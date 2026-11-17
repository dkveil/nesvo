import type { ComponentProps } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { Spinner } from '@/shared/ui/spinner';

type StatusTone = 'info' | 'error' | 'warning' | 'success' | 'loading';

type StatusMessageProps = ComponentProps<'p'> & {
  tone?: StatusTone;
  variant?: 'inline' | 'notice';
  icon?: boolean;
};

const icons = {
  info: Info,
  error: CircleX,
  warning: TriangleAlert,
  success: CircleCheck,
} as const;

const toneText: Record<StatusTone, string> = {
  info: 'text-muted-foreground',
  loading: 'text-muted-foreground',
  error: 'text-error-foreground',
  warning: 'text-warning-foreground',
  success: 'text-success-foreground',
};

export function StatusMessage({
  tone = 'info',
  variant = 'inline',
  icon = true,
  className,
  children,
  ...props
}: StatusMessageProps) {
  const Icon = tone === 'loading' ? null : icons[tone];
  const notice = variant === 'notice';
  return (
    <p
      data-slot="status-message"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex min-w-0 items-start gap-1.5 [overflow-wrap:anywhere]',
        notice
          ? [
              'gap-2 rounded-control px-3 py-2 text-xs leading-5 text-muted-foreground',
              tone !== 'info' && tone !== 'loading' && 'bg-accent',
            ]
          : ['text-2xs leading-4', toneText[tone]],
        className,
      )}
      {...props}
    >
      {icon && tone === 'loading' && (
        <Spinner className={cn('mt-px', notice ? 'mt-0.5' : 'size-3')} />
      )}
      {icon && Icon && (
        <Icon
          aria-hidden="true"
          className={cn(
            'shrink-0',
            notice ? 'mt-0.5 size-3.5' : 'mt-0.5 size-3',
            notice && tone !== 'info' && toneText[tone],
          )}
        />
      )}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export type { StatusTone };
