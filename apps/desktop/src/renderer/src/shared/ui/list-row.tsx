import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

type ListRowDensity = 'tree' | 'compact' | 'two-line' | 'grid';

type ListRowProps = Omit<ComponentProps<'div'>, 'title' | 'onClick'> & {
  density?: ListRowDensity;
  tone?: 'default' | 'sidebar';
  leading?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
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

const densityClasses: Record<ListRowDensity, string> = {
  tree: 'h-5.5 gap-1.5 text-ui',
  compact: 'h-7 gap-2 text-ui',
  'two-line': 'min-h-11 gap-2.5 py-1 text-ui',
  grid: 'grid h-8 items-center gap-3 text-ui',
};

export function ListRow({
  density = 'compact',
  tone = 'default',
  leading,
  title,
  description,
  trailing,
  actions,
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
  ...props
}: ListRowProps) {
  const interactive = !!onClick;
  const inset = BASE_INSET_PX + level * TREE_INDENT_PX;
  const content =
    density === 'grid' ? (
      children
    ) : (
      <>
        {leading && (
          <span className="flex shrink-0 items-center text-muted-foreground [&_svg:not([class*=size-])]:size-3.5">
            {leading}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              'truncate',
              density === 'two-line' && 'font-medium',
              tone === 'sidebar' && 'text-sidebar-foreground',
            )}
          >
            {title ?? children}
          </span>
          {description && density === 'two-line' && (
            <span className="truncate text-2xs text-muted-foreground">
              {description}
            </span>
          )}
        </span>
        {trailing && (
          <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground tabular-nums">
            {trailing}
          </span>
        )}
      </>
    );
  const layout = cn(
    'flex min-w-0 flex-1 items-center text-left',
    densityClasses[density],
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
          'data-selected:bg-highlight',
        ],
        tone === 'sidebar' && [
          'text-sidebar-foreground',
          interactive && 'not-data-disabled:hover:bg-sidebar-row-hover',
          'data-selected:bg-sidebar-row-selected data-selected:shadow-(--sidebar-row-selected-shadow)',
        ],
        'data-disabled:opacity-50',
        'data-[drop=inside]:bg-accent data-[drop=inside]:outline-1 data-[drop=inside]:-outline-offset-1 data-[drop=inside]:outline-ring',
        className,
      )}
      style={{ ...style, paddingLeft: interactive ? undefined : inset }}
      {...props}
    >
      {interactive ? (
        <button
          type="button"
          disabled={disabled}
          aria-current={selected ? 'true' : undefined}
          {...mainProps}
          onClick={onClick}
          style={{ paddingLeft: inset, ...gridStyle, ...mainProps?.style }}
          className={cn(
            layout,
            'focus-ring h-full self-stretch rounded-control pr-2 disabled:cursor-not-allowed',
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
        <span className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity duration-fast group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-data-selected/row:opacity-100">
          {actions}
        </span>
      )}
      {(dropIndicator === 'before' || dropIndicator === 'after') && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute right-1 left-1 h-0.5 rounded-full bg-ring',
            dropIndicator === 'before' ? '-top-px' : '-bottom-px',
          )}
        />
      )}
    </div>
  );
}
