import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { SearchField } from '@/shared/ui/search-field';

export function Panel({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      data-slot="panel"
      className={cn(
        'flex min-h-0 min-w-0 flex-col bg-background text-foreground',
        className,
      )}
      {...props}
    />
  );
}

type PanelHeaderProps = {
  icon?: LucideIcon;
  titleBar?: boolean;
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function PanelHeader({
  icon: Icon,
  titleBar = false,
  title,
  meta,
  children,
  className,
}: PanelHeaderProps) {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        'flex h-10 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3',
        titleBar &&
          'drag-region h-(--shell-topbar-height) pr-[calc(0.375rem+var(--panel-edge-inset,0px))]',
        className,
      )}
    >
      {Icon && (
        <Icon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <h2 className="shrink-0 text-ui font-semibold">{title}</h2>
      {meta && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {meta}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {children}
      </div>
    </header>
  );
}

export function PanelBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-body"
      className={cn('min-h-0 flex-1 overflow-y-auto', className)}
      {...props}
    />
  );
}

export function PanelAction({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        'text-muted-foreground enabled:hover:text-foreground aria-pressed:bg-highlight aria-pressed:text-foreground [&_svg:not([class*=size-])]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}

export function PanelSearch({
  className,
  ...props
}: Omit<ComponentProps<typeof SearchField>, 'variant'>) {
  return (
    <SearchField variant="panel" containerClassName={className} {...props} />
  );
}

type ToolbarProps = ComponentProps<'div'> & {
  label: string;
  bordered?: boolean;
};

export function Toolbar({
  label,
  bordered = true,
  className,
  ...props
}: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-slot="toolbar"
      className={cn(
        'flex h-9 shrink-0 items-center gap-1 px-1.5',
        bordered && 'border-b',
        className,
      )}
      {...props}
    />
  );
}

export function ToolbarSeparator({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('mx-1 h-4 w-px shrink-0 bg-border', className)}
    />
  );
}

export function ToolbarSpacer() {
  return <span aria-hidden="true" className="flex-1" />;
}
