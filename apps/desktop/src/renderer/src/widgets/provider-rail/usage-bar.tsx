import { cn } from 'cn';
import { ProviderGlyph, type Provider } from '@/entities/session';
import {
  formatPercent,
  type AllowanceLevel,
  type IndicatorState,
} from './usage-state';

type Props = {
  provider: Provider;
  remaining: number | null;
  level: AllowanceLevel | null;
  state: IndicatorState;
};

const stateText: Partial<Record<IndicatorState, string>> = {
  unavailable: 'Unavailable',
  offline: 'Offline',
  checking: 'Checking…',
};

export function UsageBar({ provider, remaining, level, state }: Props) {
  const hasFill = remaining !== null;
  return (
    <span className="flex w-full items-center gap-2.5">
      <ProviderGlyph
        provider={provider}
        className={cn(
          'size-3.5',
          state === 'current' ? 'text-foreground' : 'text-muted-foreground',
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          'relative h-1 min-w-0 flex-1 overflow-hidden rounded-full',
          hasFill
            ? 'bg-(--usage-ring-track)'
            : 'bg-[repeating-linear-gradient(90deg,var(--usage-ring-track)_0_3px,transparent_3px_6px)]',
          state === 'checking' && 'animate-pulse motion-reduce:animate-none',
        )}
      >
        {hasFill && (
          <span
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out',
              state === 'offline'
                ? 'bg-muted-foreground/60'
                : [
                    level === 'high' && 'bg-success-foreground',
                    level === 'medium' && 'bg-warning-foreground',
                    level === 'low' && 'bg-error-foreground',
                  ],
              state === 'stale' && 'opacity-45',
            )}
            style={{ width: `${remaining}%` }}
          />
        )}
      </span>
      <span className="flex w-16 shrink-0 items-center justify-end gap-1.5 text-[11px] text-muted-foreground tabular-nums">
        {hasFill ? formatPercent(remaining) : stateText[state]}
        {(state === 'offline' || state === 'stale') && (
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 rounded-full',
              state === 'offline'
                ? 'bg-muted-foreground'
                : 'bg-warning-foreground',
            )}
          />
        )}
      </span>
    </span>
  );
}
