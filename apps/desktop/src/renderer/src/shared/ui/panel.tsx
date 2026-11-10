import type { ComponentProps, ReactNode } from 'react';
import { Search, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/shared/ui/button';

type PanelHeaderProps = {
  icon: LucideIcon;
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
};

export function PanelHeader({
  icon: Icon,
  title,
  meta,
  children,
}: PanelHeaderProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3">
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <h2 className="shrink-0 text-[13px] font-semibold">{title}</h2>
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
        'size-7 text-muted-foreground enabled:hover:text-foreground aria-pressed:bg-highlight aria-pressed:text-foreground [&_svg:not([class*=size-])]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}

export function PanelSearch({ className, ...props }: ComponentProps<'input'>) {
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors duration-100 focus-within:bg-accent focus-within:ring-1 focus-within:ring-ring/70 focus-within:ring-inset hover:bg-accent',
        className,
      )}
    >
      <Search className="size-3.5 shrink-0" aria-hidden="true" />
      <input
        type="search"
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        {...props}
      />
    </div>
  );
}
