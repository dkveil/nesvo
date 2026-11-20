import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';

type TabOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
  closable?: boolean;
};

type TabsProps<T extends string> = {
  label: string;
  idPrefix: string;
  value: T;
  options: TabOption<T>[];
  onChange: (value: T) => void;
  onClose?: (value: T) => void;
  variant?: 'underline' | 'editor';
  keepLabelsVisible?: boolean;
  className?: string;
};

type Indicator = { left: number; width: number };

const tabId = (prefix: string, value: string) => `${prefix}-tab-${value}`;
const panelId = (prefix: string, value: string) => `${prefix}-panel-${value}`;

function useIndicator(active: string, layoutKey: string) {
  const list = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const tab = list.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      if (!tab) return;
      const next = { left: tab.offsetLeft, width: tab.offsetWidth };
      setIndicator(previous =>
        previous?.left === next.left && previous.width === next.width
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, [active, layoutKey]);
  return { list, indicator };
}

export function Tabs<T extends string>({
  label,
  idPrefix,
  value,
  options,
  onChange,
  onClose,
  variant = 'underline',
  keepLabelsVisible = false,
  className,
}: TabsProps<T>) {
  const layoutKey = options
    .map(option => `${option.value}:${option.label}:${option.count ?? ''}`)
    .join('|');
  const { list, indicator } = useIndicator(value, layoutKey);
  const focusTab = (next: T) =>
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus(),
    );
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex(option => option.value === value);
    const target =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : null;
    if (target === null) {
      const current = options[index];
      if (
        event.key === 'Delete' &&
        onClose &&
        current?.closable &&
        event.target instanceof HTMLElement &&
        event.target.getAttribute('role') === 'tab'
      ) {
        event.preventDefault();
        onClose(current.value);
      }
      return;
    }
    const next = options[(target + options.length) % options.length];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    focusTab(next.value);
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      data-variant={variant}
      onKeyDown={move}
      className={cn(
        'relative flex shrink-0 items-stretch',
        variant === 'underline' && 'h-8 gap-1 border-b px-2',
        variant === 'editor' && 'h-8 overflow-x-auto border-b bg-card',
        keepLabelsVisible && 'overflow-x-auto',
        className,
      )}
    >
      {options.map(option => {
        const selected = option.value === value;
        const closable = variant === 'editor' && option.closable && !!onClose;
        return (
          <div
            key={option.value}
            data-selected={selected ? '' : undefined}
            className={cn(
              'group/tab relative flex min-w-0 items-stretch',
              keepLabelsVisible && 'shrink-0',
              variant === 'editor' &&
                'max-w-48 border-r text-muted-foreground transition-colors duration-fast hover:text-foreground data-selected:bg-background data-selected:text-foreground',
            )}
          >
            <button
              type="button"
              role="tab"
              data-tab={option.value}
              id={tabId(idPrefix, option.value)}
              aria-selected={selected}
              aria-controls={panelId(idPrefix, option.value)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
              onAuxClick={event => {
                if (event.button === 1 && closable) onClose?.(option.value);
              }}
              className={cn(
                'focus-ring flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap transition-colors duration-fast ease-out [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5',
                variant === 'underline' &&
                  'rounded-sm px-2 text-muted-foreground hover:text-foreground aria-selected:text-foreground',
                variant === 'underline' && keepLabelsVisible && 'px-1.5',
                variant === 'editor' && 'pl-3',
                variant === 'editor' && (closable ? 'pr-1' : 'pr-3'),
              )}
            >
              {option.icon}
              <span className="truncate">{option.label}</span>
              {option.count != null && (
                <span className="text-2xs text-muted-foreground tabular-nums">
                  {option.count}
                </span>
              )}
            </button>
            {closable && (
              <span className="flex items-center pr-1.5">
                <IconButton
                  size={16}
                  tabIndex={-1}
                  label={`Close ${option.label}`}
                  tooltip={false}
                  onClick={() => onClose?.(option.value)}
                  className="opacity-0 group-hover/tab:opacity-100 group-data-selected/tab:opacity-100"
                >
                  <X aria-hidden="true" />
                </IconButton>
              </span>
            )}
            {variant === 'editor' && selected && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-px bg-foreground/70"
              />
            )}
          </div>
        );
      })}
      {variant === 'underline' && indicator && (
        <span
          aria-hidden="true"
          style={{
            transform: `translateX(${indicator.left}px)`,
            width: indicator.width,
          }}
          className="pointer-events-none absolute bottom-0 left-0 h-px bg-foreground transition-[transform,width] duration-base ease-out"
        />
      )}
    </div>
  );
}

type TabPanelProps = ComponentProps<'div'> & {
  idPrefix: string;
  value: string;
};

export function TabPanel({ idPrefix, value, ...props }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, value)}
      aria-labelledby={tabId(idPrefix, value)}
      {...props}
    />
  );
}

export type { TabOption };
