import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';
import { SectionLabel } from '@/shared/ui/section-label';

type SectionProps = {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  actionLayout?: 'inline' | 'stacked';
  description?: ReactNode;
  className?: string;
};

export function SettingsSection({
  title,
  children,
  action,
  actionLayout = 'inline',
  description,
  className,
}: SectionProps) {
  return (
    <section aria-label={title} className="space-y-2">
      <SectionLabel
        as="h2"
        emphasis
        action={action}
        className={cn(
          'px-3',
          actionLayout === 'stacked' &&
            'h-auto flex-col items-start gap-1.5 [&>div]:max-w-full',
        )}
      >
        {title}
      </SectionLabel>
      {description && (
        <p className="px-3 text-xs text-muted-foreground">{description}</p>
      )}
      <SettingsRows className={className}>{children}</SettingsRows>
    </section>
  );
}

export function SettingsRows({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-section-rows"
      className={cn('[&>*+*]:shadow-[inset_0_1px_0_var(--border)]', className)}
    >
      {children}
    </div>
  );
}

type RowProps = {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function SettingsRow({
  title,
  description,
  children,
  className,
}: RowProps) {
  return (
    <div
      data-slot="settings-row"
      className={cn(
        'grid min-h-12 grid-cols-[minmax(0,1fr)_auto] content-center items-center gap-x-4 gap-y-1 px-3 py-2',
        className,
      )}
    >
      <div
        className={cn(
          'col-start-1 row-start-1 min-w-0 text-ui font-medium [overflow-wrap:anywhere]',
          !children && 'col-span-2',
        )}
      >
        {title}
      </div>
      {children && (
        <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
          {children}
        </div>
      )}
      {description && (
        <div className="col-span-2 row-start-2 text-xs leading-4 text-subtle-foreground [overflow-wrap:anywhere]">
          {description}
        </div>
      )}
    </div>
  );
}
