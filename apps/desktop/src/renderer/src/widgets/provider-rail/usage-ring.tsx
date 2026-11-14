import { cn } from 'cn';
import { ProviderGlyph, type Provider } from '@/entities/session';
import type { AllowanceLevel, IndicatorState } from './usage-state';

type Props = {
  provider: Provider;
  remaining: number | null;
  level: AllowanceLevel | null;
  state: IndicatorState;
};

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function UsageRing({ provider, remaining, level, state }: Props) {
  const hasArc = remaining !== null;
  const offset = RING_CIRCUMFERENCE * (1 - (remaining ?? 0) / 100);
  return (
    <span className="relative grid size-6 place-items-center">
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
          strokeWidth="2.5"
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
            strokeWidth="2.5"
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
      <ProviderGlyph
        provider={provider}
        className={cn(
          'size-3',
          state === 'current' ? 'text-foreground' : 'text-muted-foreground',
        )}
      />
      {state === 'offline' && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar bg-muted-foreground"
        />
      )}
      {state === 'stale' && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar bg-warning-foreground"
        />
      )}
    </span>
  );
}
