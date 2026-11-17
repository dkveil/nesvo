import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from 'cn';

type EmptyStateProps = Omit<ComponentProps<'div'>, 'title'> & {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: 'sm' | 'md';
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'md',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'md' && 'min-h-80 gap-2 px-6',
        size === 'sm' && 'gap-1.5 px-4 py-8',
        className,
      )}
      {...props}
    >
      {Icon && (
        <span
          className={cn(
            'flex items-center justify-center border bg-card text-muted-foreground',
            size === 'md' && 'mb-2 size-10 rounded-overlay',
            size === 'sm' && 'mb-1 size-8 rounded-surface',
          )}
        >
          <Icon
            aria-hidden="true"
            className={size === 'md' ? 'size-4.5' : 'size-4'}
          />
        </span>
      )}
      <h2
        className={cn(
          'font-semibold tracking-tight',
          size === 'md' ? 'text-title' : 'text-ui',
        )}
      >
        {title}
      </h2>
      {description && (
        <p className="max-w-sm text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-2 flex items-center gap-2">{action}</div>}
    </div>
  );
}
