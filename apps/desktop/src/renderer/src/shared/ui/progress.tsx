import type { ComponentProps } from 'react';
import { cn } from 'cn';

type BarTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

type BarProps = Omit<ComponentProps<'div'>, 'children'> & {
  value: number | null;
  label: string;
  tone?: BarTone;
  stale?: boolean;
};

const fillTones: Record<BarTone, string> = {
  neutral: 'bg-foreground/70',
  info: 'bg-info-foreground',
  success: 'bg-success-foreground',
  warning: 'bg-warning-foreground',
  error: 'bg-error-foreground',
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));

function BarTrack({
  value,
  tone = 'neutral',
  stale = false,
  indeterminate = false,
}: {
  value: number | null;
  tone?: BarTone;
  stale?: boolean;
  indeterminate?: boolean;
}) {
  const hasFill = value !== null;
  return (
    <>
      {indeterminate && (
        <span
          className={cn(
            'absolute inset-y-0 left-0 w-2/5 rounded-full animate-[progress-indeterminate_1.4s_ease-in-out_infinite]',
            fillTones[tone],
          )}
        />
      )}
      {!indeterminate && hasFill && (
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-slow ease-out',
            fillTones[tone],
            stale && 'opacity-45',
          )}
          style={{ width: `${clamp(value)}%` }}
        />
      )}
    </>
  );
}

const trackClasses = (empty: boolean) =>
  cn(
    'relative h-1 w-full min-w-0 overflow-hidden rounded-full',
    empty
      ? 'bg-[repeating-linear-gradient(90deg,var(--usage-ring-track)_0_3px,transparent_3px_6px)]'
      : 'bg-track',
  );

export function Meter({
  value,
  label,
  tone,
  stale,
  className,
  ...props
}: BarProps) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={value === null ? 'Unavailable' : undefined}
      data-stale={stale ? '' : undefined}
      className={cn(trackClasses(value === null), className)}
      {...props}
    >
      <BarTrack value={value} tone={tone} stale={stale} />
    </div>
  );
}

type ProgressProps = BarProps & { indeterminate?: boolean };

export function Progress({
  value,
  label,
  tone,
  stale,
  indeterminate = false,
  className,
  ...props
}: ProgressProps) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate || value === null ? undefined : value}
      aria-busy={indeterminate || undefined}
      className={cn(trackClasses(false), className)}
      {...props}
    >
      <BarTrack
        value={value}
        tone={tone}
        stale={stale}
        indeterminate={indeterminate}
      />
    </div>
  );
}

export type { BarTone };
