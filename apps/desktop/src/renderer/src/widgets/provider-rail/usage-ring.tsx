import { cn } from 'cn';
import type { AllowanceLevel, IndicatorState } from './usage-state';

type Props = {
  mark: string;
  remaining: number | null;
  level: AllowanceLevel | null;
  state: IndicatorState;
  size?: 'sm' | 'md';
};

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function UsageRing({
  mark,
  remaining,
  level,
  state,
  size = 'md',
}: Props) {
  const hasArc = remaining !== null;
  const offset = RING_CIRCUMFERENCE * (1 - (remaining ?? 0) / 100);
  return (
    <span
      className={cn(
        'relative grid place-items-center',
        size === 'md' ? 'size-9' : 'size-7',
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 36 36"
        className="pointer-events-none absolute inset-0 size-full -rotate-90"
      >
        <circle
          cx="18"
          cy="18"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.25"
          strokeDasharray={hasArc ? undefined : '2 3'}
          className={cn(
            'stroke-(--usage-ring-track)',
            state === 'checking' && 'animate-pulse',
          )}
        />
        {hasArc && (
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={offset}
            className={cn(
              'transition-[stroke-dashoffset] duration-300 ease-out',
              state === 'offline'
                ? 'stroke-muted-foreground/60'
                : [
                    level === 'high' && 'stroke-success-foreground',
                    level === 'medium' && 'stroke-warning-foreground',
                    level === 'low' && 'stroke-error-foreground',
                  ],
              state === 'stale' && 'opacity-45',
            )}
          />
        )}
      </svg>
      <span
        className={cn(
          'leading-none font-semibold tracking-wide',
          size === 'md' ? 'text-[10px]' : 'text-[9px]',
          state === 'current' ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {mark}
      </span>
      {state === 'offline' && (
        <span
          aria-hidden="true"
          className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-sidebar bg-muted-foreground"
        />
      )}
      {state === 'stale' && (
        <span
          aria-hidden="true"
          className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-sidebar bg-warning-foreground"
        />
      )}
    </span>
  );
}
