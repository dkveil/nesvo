import type { ComponentProps, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { Collapsible } from 'radix-ui';

type DisclosureProps = Omit<
  ComponentProps<typeof Collapsible.Root>,
  'title'
> & {
  title: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  contentClassName?: string;
};

export function Disclosure({
  title,
  meta,
  icon,
  className,
  contentClassName,
  children,
  ...props
}: DisclosureProps) {
  return (
    <Collapsible.Root
      data-slot="disclosure"
      className={cn('min-w-0', className)}
      {...props}
    >
      <Collapsible.Trigger className="group/disclosure focus-ring flex h-7 w-full min-w-0 items-center gap-1.5 rounded-control px-2 text-left text-ui text-foreground transition-colors duration-fast enabled:hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out group-data-[state=open]/disclosure:rotate-90"
        />
        {icon && (
          <span className="flex shrink-0 items-center text-muted-foreground [&_svg:not([class*=size-])]:size-3.5">
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta && (
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {meta}
          </span>
        )}
      </Collapsible.Trigger>
      <Collapsible.Content
        className={cn(
          'overflow-hidden pt-1 pb-1 pl-7 text-xs text-muted-foreground',
          contentClassName,
        )}
      >
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
