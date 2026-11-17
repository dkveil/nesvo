import { useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Collapsible } from 'radix-ui';

type DisclosureRowProps = {
  title: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
};

type DisclosureProps = Omit<ComponentProps<typeof Collapsible.Root>, 'title'> &
  DisclosureRowProps & {
    triggerLabel?: string;
    contentClassName?: string;
  };

type NativeDisclosureProps = Omit<
  ComponentProps<'details'>,
  'title' | 'open' | 'onToggle'
> &
  DisclosureRowProps & {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    triggerLabel?: string;
    contentClassName?: string;
  };

const triggerClass =
  'group/disclosure focus-ring flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-control px-2 text-left text-ui text-foreground transition-colors duration-fast not-data-disabled:hover:bg-accent data-disabled:cursor-not-allowed data-disabled:opacity-50';

const contentClass =
  'overflow-hidden pt-1 pb-1 pl-7 text-xs text-muted-foreground';

function DisclosureRow({ title, meta, icon, description }: DisclosureRowProps) {
  return (
    <>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out group-data-[state=open]/disclosure:rotate-90',
          description && 'mt-1.75 self-start',
        )}
      />
      {icon && (
        <span
          className={cn(
            'flex h-5 shrink-0 items-center text-muted-foreground [&_svg:not([class*=size-])]:size-3.5',
            description && 'mt-1 self-start',
          )}
        >
          {icon}
        </span>
      )}
      <span
        className={cn('flex min-w-0 flex-1 flex-col', description && 'py-1')}
      >
        <span className="truncate">{title}</span>
        {description && (
          <span className="flex flex-col text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {typeof description === 'string' ? (
              <span className="line-clamp-2">{description}</span>
            ) : (
              description
            )}
          </span>
        )}
      </span>
      {meta && (
        <span
          className={cn(
            'shrink-0 text-2xs text-muted-foreground tabular-nums',
            description && 'mt-1 self-start leading-5',
          )}
        >
          {meta}
        </span>
      )}
    </>
  );
}

export function Disclosure({
  title,
  meta,
  icon,
  description,
  triggerLabel,
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
      <Collapsible.Trigger aria-label={triggerLabel} className={triggerClass}>
        <DisclosureRow
          title={title}
          meta={meta}
          icon={icon}
          description={description}
        />
      </Collapsible.Trigger>
      <Collapsible.Content className={cn(contentClass, contentClassName)}>
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function NativeDisclosure({
  title,
  meta,
  icon,
  description,
  triggerLabel,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  contentClassName,
  children,
  ...props
}: NativeDisclosureProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const expanded = open ?? uncontrolled;
  return (
    <details
      data-slot="disclosure"
      open={expanded}
      onToggle={event => {
        const next = event.currentTarget.open;
        if (next === expanded) return;
        setUncontrolled(next);
        onOpenChange?.(next);
      }}
      className={cn('min-w-0', className)}
      {...props}
    >
      <summary
        aria-label={triggerLabel}
        data-state={expanded ? 'open' : 'closed'}
        className={cn(
          triggerClass,
          'cursor-default list-none [&::-webkit-details-marker]:hidden',
        )}
      >
        <DisclosureRow
          title={title}
          meta={meta}
          icon={icon}
          description={description}
        />
      </summary>
      <div className={cn(contentClass, contentClassName)}>{children}</div>
    </details>
  );
}
