import type { ReactNode } from 'react';
import { cn } from 'cn';

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
    <section aria-label={title} className="space-y-2.5">
      <header className="flex min-h-7 items-center justify-between gap-3 px-3">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {action}
      </header>
      <div
        className={cn(
          'divide-y rounded-lg border bg-card text-card-foreground',
          className,
        )}
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
        'flex min-h-14 items-center justify-between gap-4 px-3 py-2.5',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[13px] font-medium [overflow-wrap:anywhere]">
          {title}
        </div>
        {description && (
          <div className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
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
