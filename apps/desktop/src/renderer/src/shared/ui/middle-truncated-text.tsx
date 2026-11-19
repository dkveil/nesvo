import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';

type Props = Omit<ComponentProps<'span'>, 'children'> & {
  value: string;
  path?: boolean;
};

export function MiddleTruncatedText({
  value,
  className,
  path = false,
  ...props
}: Props) {
  const characters = Array.from(value);
  const split = Math.max(
    Math.ceil(characters.length / 2),
    characters.length - 24,
  );
  const candidate = value.replace(/[\\/]+$/, '');
  const separator = Math.max(
    candidate.lastIndexOf('/'),
    candidate.lastIndexOf('\\'),
  );
  const [head, tail] =
    path && separator >= 0
      ? [value.slice(0, separator + 1), value.slice(separator + 1)]
      : [characters.slice(0, split).join(''), characters.slice(split).join('')];

  return (
    <span
      {...props}
      dir="ltr"
      data-slot="middle-truncated-text"
      title={value}
      className={cn('flex min-w-0 overflow-hidden', className)}
    >
      <span className="min-w-0 truncate text-left">{head}</span>
      <span
        className={cn(
          'flex min-w-0 shrink-0 justify-end overflow-hidden whitespace-nowrap',
          path ? 'max-w-3/4' : 'max-w-1/2',
        )}
      >
        {tail}
      </span>
    </span>
  );
}
