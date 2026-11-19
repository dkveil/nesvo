import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';
import { SectionLabel } from '@/shared/ui/section-label';

type SectionProps = {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function SettingsSection({
  title,
  children,
  action,
  className,
}: SectionProps) {
  return (
    <section aria-label={title} className="space-y-1.5">
      <SectionLabel as="h2" action={action} className="px-3">
        {title}
      </SectionLabel>
      <div
        data-slot="settings-section-rows"
        className={cn('divide-y divide-border', className)}
      >
        {children}
      </div>
    </section>
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
      className={cn(
        'flex min-h-12 items-center justify-between gap-4 px-3 py-2',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-ui font-medium [overflow-wrap:anywhere]">
          {title}
        </div>
        {description && (
          <div className="text-2xs leading-4 text-subtle-foreground [overflow-wrap:anywhere]">
            {description}
          </div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      )}
    </div>
  );
}
