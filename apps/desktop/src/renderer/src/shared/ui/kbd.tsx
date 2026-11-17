import type { ComponentProps } from 'react';
import { cn } from 'cn';

type KbdTone = 'default' | 'tooltip';

type KbdProps = ComponentProps<'kbd'> & {
  size?: 'sm' | 'md';
  tone?: KbdTone;
};

export function Kbd({
  size = 'sm',
  tone = 'default',
  className,
  ...props
}: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm font-sans leading-none font-medium select-none',
        size === 'sm' && 'h-4 min-w-4 px-1 text-micro',
        size === 'md' && 'h-5 min-w-5 px-1.5 text-2xs',
        tone === 'default' && 'border bg-kbd/60 text-muted-foreground',
        tone === 'tooltip' && 'bg-tooltip-key text-tooltip-foreground/70',
        className,
      )}
      {...props}
    />
  );
}

type KeyComboProps = Omit<ComponentProps<'span'>, 'children'> & {
  keys: string;
  size?: 'sm' | 'md';
  tone?: KbdTone;
};

export function KeyCombo({
  keys,
  size,
  tone,
  className,
  ...props
}: KeyComboProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex items-center gap-0.5', className)}
      {...props}
    >
      {keys.split(' ').map(key => (
        <Kbd key={key} size={size} tone={tone}>
          {key}
        </Kbd>
      ))}
    </span>
  );
}
