import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/shared/lib/cn';

export type PanelTab = 'summary' | 'timeline' | 'code';

type TabOption = { value: PanelTab; label: string; count?: number };

type PanelTabsProps = {
  value: PanelTab;
  options: TabOption[];
  onChange: (value: PanelTab) => void;
};

type Indicator = { left: number; width: number };

export function PanelTabs({ value, options, onChange }: PanelTabsProps) {
  const list = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const layoutKey = options
    .map(option => `${option.value}:${option.label}:${option.count ?? ''}`)
    .join('|');
  useLayoutEffect(() => {
    const measure = () => {
      const active = list.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      if (!active) return;
      const next = { left: active.offsetLeft, width: active.offsetWidth };
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
  }, [value, layoutKey]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = options.findIndex(option => option.value === value);
    const next =
      options[
        (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) %
          options.length
      ];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLElement>(`[data-tab="${next.value}"]`)
        ?.focus(),
    );
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Pull request sections"
      onKeyDown={move}
      className="relative flex h-8 shrink-0 items-stretch gap-1 border-b px-2"
    >
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            data-tab={option.value}
            id={`pull-request-tab-${option.value}`}
            aria-selected={selected}
            aria-controls={`pull-request-panel-${option.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors duration-150 ease-out outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
              selected && 'text-foreground',
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="text-2xs text-muted-foreground tabular-nums">
                {option.count}
              </span>
            )}
          </button>
        );
      })}
      {indicator && (
        <span
          aria-hidden="true"
          style={{
            transform: `translateX(${indicator.left}px)`,
            width: indicator.width,
          }}
          className="pointer-events-none absolute bottom-0 left-0 h-px bg-foreground transition-[transform,width] duration-150 ease-out motion-reduce:transition-none"
        />
      )}
    </div>
  );
}
