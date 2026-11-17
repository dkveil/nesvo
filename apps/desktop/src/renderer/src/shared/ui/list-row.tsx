import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

type ListRowDensity = 'tree' | 'compact' | 'two-line' | 'grid';
type ListRowSize = 'md' | 'sm';

type ListRowProps = Omit<ComponentProps<'div'>, 'title' | 'onClick'> & {
  density?: ListRowDensity;
  size?: ListRowSize;
  tone?: 'default' | 'sidebar';
  heading?: boolean;
  leading?: ReactNode;
  title?: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  actionsPlacement?: 'inline' | 'overlay';
  selected?: boolean;
  disabled?: boolean;
  level?: number;
  columns?: string;
  dropIndicator?: 'before' | 'after' | 'inside' | null;
  onClick?: ComponentProps<'button'>['onClick'];
  mainProps?: Omit<ComponentProps<'button'>, 'children' | 'onClick'>;
};

const TREE_INDENT_PX = 12;
const BASE_INSET_PX = 8;

const densityClasses: Record<ListRowSize, Record<ListRowDensity, string>> = {
  md: {
    tree: 'h-5.5 gap-1.5 text-ui',
    compact: 'h-7 gap-2 text-ui',
    'two-line': 'min-h-11 gap-2.5 py-1 text-ui',
    grid: 'grid h-8 items-center gap-3 text-ui',
  },
  sm: {
    tree: 'h-5.5 gap-1.5 text-xs',
    compact: 'h-7 gap-1.5 text-xs',
    'two-line': 'min-h-10 items-start gap-1.5 py-1 text-xs',
    grid: 'grid h-7 items-center gap-3 text-xs',
  },
};

const hiddenWhileActionsShow =
  'group-hover/row:invisible group-focus-within/row:invisible group-has-[[data-slot=list-row-actions]_[aria-expanded=true]]/row:invisible';

export function ListRow({
  density = 'compact',
  size = 'md',
  tone = 'default',
  heading = false,
  leading,
  title,
  meta,
  description,
  trailing,
  actions,
  actionsPlacement = 'inline',
  selected = false,
  disabled = false,
  level = 0,
  columns,
  dropIndicator = null,
  onClick,
  mainProps,
  className,
  style,
  children,
  'aria-expanded': ariaExpanded,
  'aria-haspopup': ariaHasPopup,
  'aria-controls': ariaControls,
  ...props
}: ListRowProps) {
  const interactive = !!onClick;
  const sidebar = tone === 'sidebar';
  const overlay = !!actions && actionsPlacement === 'overlay';
  const twoLine = density === 'two-line';
  const mutedText = sidebar
    ? 'text-sidebar-muted-foreground'
    : 'text-muted-foreground';
  const disclosureProps = {
    'aria-expanded': ariaExpanded,
    'aria-haspopup': ariaHasPopup,
    'aria-controls': ariaControls,
  };
  const inset = BASE_INSET_PX + level * TREE_INDENT_PX;
  const content =
    density === 'grid' ? (
      children
    ) : (
      <>
        {leading && (
          <span
            className={cn(
              'flex shrink-0 items-center [&_svg:not([class*=size-])]:size-3.5',
              sidebar ? 'text-sidebar-icon' : 'text-muted-foreground',
              twoLine && size === 'sm' && 'h-4',
            )}
          >
            {leading}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                twoLine && 'font-medium',
                sidebar && 'text-sidebar-foreground',
                heading && [
                  'font-medium',
                  sidebar
                    ? 'text-sidebar-muted-foreground group-hover/row:text-sidebar-foreground'
                    : 'text-muted-foreground group-hover/row:text-foreground',
                ],
              )}
            >
              {title ?? children}
            </span>
            {meta && twoLine && (
              <span
                className={cn(
                  'flex shrink-0 items-center gap-1 text-2xs leading-4 tabular-nums',
                  mutedText,
                  overlay && hiddenWhileActionsShow,
                )}
              >
                {meta}
              </span>
            )}
          </span>
          {description && twoLine && (
            <span className={cn('truncate text-2xs', mutedText)}>
              {description}
            </span>
          )}
        </span>
        {trailing && (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-2xs tabular-nums',
              mutedText,
              overlay && hiddenWhileActionsShow,
            )}
          >
            {trailing}
          </span>
        )}
      </>
    );
  const layout = cn(
    'flex min-w-0 flex-1 items-center text-left',
    densityClasses[size][density],
  );
  const gridStyle: CSSProperties | undefined =
    density === 'grid' && columns
      ? { gridTemplateColumns: columns }
      : undefined;
  return (
    <div
      data-slot="list-row"
      data-density={density}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-drop={dropIndicator ?? undefined}
      className={cn(
        'group/row relative flex min-w-0 items-center rounded-control transition-colors duration-fast',
        tone === 'default' && [
          'text-foreground',
          interactive && 'not-data-disabled:hover:bg-accent',
          'data-[state=open]:bg-accent data-selected:bg-highlight',
        ],
        sidebar && [
          'text-sidebar-foreground',
          interactive && 'not-data-disabled:hover:bg-sidebar-row-hover',
          'data-[state=open]:bg-sidebar-row-hover',
          'data-selected:bg-sidebar-row-selected data-selected:shadow-(--sidebar-row-selected-shadow)',
        ],
        'data-disabled:opacity-50',
        'data-[drop=inside]:bg-accent data-[drop=inside]:outline-1 data-[drop=inside]:-outline-offset-1 data-[drop=inside]:outline-ring',
        className,
      )}
      style={{ ...style, paddingLeft: interactive ? undefined : inset }}
      {...(interactive ? {} : disclosureProps)}
      {...props}
    >
      {interactive ? (
        <button
          type="button"
          disabled={disabled}
          aria-current={selected ? 'true' : undefined}
          {...disclosureProps}
          {...mainProps}
          onClick={onClick}
          style={{ paddingLeft: inset, ...gridStyle, ...mainProps?.style }}
          className={cn(
            layout,
            'focus-ring self-stretch rounded-control pr-2 disabled:cursor-not-allowed',
            mainProps?.className,
          )}
        >
          {content}
        </button>
      ) : (
        <div className={cn(layout, 'pr-2')} style={gridStyle}>
          {content}
        </div>
      )}
      {actions && (
        <span
          data-slot="list-row-actions"
          className={cn(
            'flex shrink-0 items-center gap-0.5 pr-1',
            overlay
              ? [
                  'invisible absolute right-1 rounded-sm pr-0 group-focus-within/row:visible group-hover/row:visible has-[[aria-expanded=true]]:visible',
                  !twoLine && 'top-1/2 -translate-y-1/2',
                  twoLine && (size === 'sm' ? 'top-0.5' : 'top-1'),
                  sidebar &&
                    'bg-sidebar-row-hover group-data-selected/row:bg-sidebar-row-selected',
                ]
              : 'opacity-0 transition-opacity duration-fast group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-data-selected/row:opacity-100',
          )}
        >
          {actions}
        </span>
      )}
      {(dropIndicator === 'before' || dropIndicator === 'after') && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-ring',
            dropIndicator === 'before' ? '-top-px' : '-bottom-px',
          )}
        />
      )}
    </div>
  );
}
