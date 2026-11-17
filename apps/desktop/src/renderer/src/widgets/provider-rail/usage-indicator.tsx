import type { Provider } from '@/entities/session';
import { IconButton } from '@/shared/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { IndicatorTooltip } from './indicator-tooltip';
import { UsageRing } from './usage-ring';
import {
  allowanceLevel,
  formatPercent,
  indicatorStateOf,
  observedWindow,
  remainingPercent,
  type UsageState,
} from './usage-state';

export type UsageLayout = 'row' | 'column' | 'account';

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
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton
          label={label}
          tooltip={false}
          tone="sidebar"
          shape="round"
          aria-haspopup="dialog"
          aria-expanded={expanded}
          data-provider-indicator={provider}
          data-usage-state={indicator}
          data-usage-stale={indicator === 'stale'}
          onClick={event => onOpen(event.currentTarget)}
        >
          <UsageRing
            provider={provider}
            remaining={shown}
            level={level}
            state={indicator}
          />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent
        side={layout === 'row' ? 'top' : 'right'}
        variant="panel"
        className="w-72"
      >
        <IndicatorTooltip
          provider={provider}
          state={state}
          indicator={indicator}
          now={now}
        />
      </TooltipContent>
    </Tooltip>
  );
}
