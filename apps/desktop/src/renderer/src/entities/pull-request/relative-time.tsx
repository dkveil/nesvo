import type { ComponentProps } from 'react';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { Hint } from '@/shared/ui/tooltip';

type RelativeTimeProps = Omit<ComponentProps<'time'>, 'children'> & {
  at: string;
  now: number;
  prefix?: string;
};

export function RelativeTime({ at, now, prefix, ...props }: RelativeTimeProps) {
  const relative = formatRelativeTime(at, now);
  return (
    <Hint label={new Date(at).toLocaleString()}>
      <time dateTime={at} {...props}>
        {prefix ? `${prefix} ${relative}` : relative}
      </time>
    </Hint>
  );
}
