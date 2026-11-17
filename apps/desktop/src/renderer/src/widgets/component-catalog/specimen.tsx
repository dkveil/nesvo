import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

type CatalogSectionProps = {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
};

export function CatalogSection({
  id,
  title,
  description,
  children,
}: CatalogSectionProps) {
  return (
    <section
      id={`catalog-${id}`}
      aria-labelledby={`catalog-${id}-title`}
      className="scroll-mt-4 space-y-4"
    >
      <header className="space-y-0.5">
        <h2
          id={`catalog-${id}-title`}
          className="text-title font-semibold tracking-tight"
        >
          {title}
        </h2>
        {description && (
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

type SpecimenProps = {
  title: string;
  source?: string;
  children: ReactNode;
  className?: string;
};

export function Specimen({
  title,
  source,
  children,
  className,
}: SpecimenProps) {
  return (
    <div className="overflow-hidden rounded-surface border bg-card">
      <div className="flex h-8 items-center justify-between gap-3 border-b px-3">
        <h3 className="truncate text-ui font-medium">{title}</h3>
        {source && (
          <code className="truncate font-mono text-2xs text-muted-foreground">
            {source}
          </code>
        )}
      </div>
      <div className={cn('space-y-3 bg-background p-4', className)}>
        {children}
      </div>
    </div>
  );
}

type SpecimenRowProps = {
  label: string;
  children: ReactNode;
  className?: string;
};

export function SpecimenRow({ label, children, className }: SpecimenRowProps) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
      <span className="truncate text-2xs text-muted-foreground">{label}</span>
      <div
        className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
      >
        {children}
      </div>
    </div>
  );
}

export function StateCaption({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      {children}
      <span className="text-micro text-muted-foreground">{label}</span>
    </div>
  );
}
