import { Tooltip } from 'radix-ui';
import { cn } from 'cn';
import type { Provider } from '@/entities/session';
import { providerMarks } from '@/features/new-thread/provider-mark';
import { IndicatorTooltip } from './indicator-tooltip';
import { UsageBar } from './usage-bar';
import { UsageRing } from './usage-ring';
import {
  allowanceLevel,
  formatPercent,
  indicatorStateOf,
  observedWindow,
  remainingPercent,
  type UsageState,
} from './usage-state';

export type UsageLayout = 'column' | 'row' | 'bars' | 'account';

type Props = {
  provider: Provider;
  state: UsageState;
  connected: boolean;
  now: number;
  expanded: boolean;
  layout: Exclude<UsageLayout, 'account'>;
  onOpen: (trigger: HTMLButtonElement) => void;
};

export function UsageIndicator({
  provider,
  state,
  connected,
  now,
  expanded,
  layout,
  onOpen,
}: Props) {
  const window = !state.error ? observedWindow(state.data) : undefined;
  const indicator = indicatorStateOf(state, window, connected, now);
  const remaining = window ? remainingPercent(window) : null;
  const shown = indicator === 'unavailable' ? null : remaining;
  const level = remaining === null ? null : allowanceLevel(remaining);
  const summary = window
    ? `${window.label}, ${formatPercent(remaining ?? 0)} remaining${indicator === 'stale' ? ', stale' : ''}`
    : state.loading
      ? 'checking'
      : 'unavailable';
  const label = `${provider} limits: ${summary}${connected ? '' : ', offline'}`;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={expanded}
          data-provider-indicator={provider}
          data-usage-state={indicator}
          data-usage-stale={indicator === 'stale'}
          className={cn(
            'outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] aria-expanded:bg-sidebar-row-selected',
            layout === 'bars'
              ? 'flex h-7 w-full items-center rounded-(--control-radius) px-(--sidebar-row-inset)'
              : 'grid place-items-center rounded-full',
            layout === 'column' && 'size-10',
            layout === 'row' && 'size-8',
          )}
          onClick={event => onOpen(event.currentTarget)}
        >
          {layout === 'bars' ? (
            <UsageBar
              mark={providerMarks[provider]}
              remaining={shown}
              level={level}
              state={indicator}
            />
          ) : (
            <UsageRing
              mark={providerMarks[provider]}
              remaining={shown}
              level={level}
              state={indicator}
              size={layout === 'row' ? 'sm' : 'md'}
            />
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={layout === 'row' ? 'top' : 'right'}
          align="center"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-80 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
        >
          <IndicatorTooltip
            provider={provider}
            state={state}
            indicator={indicator}
          />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
