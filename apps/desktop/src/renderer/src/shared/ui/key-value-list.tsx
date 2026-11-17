import type { ComponentProps, ReactNode } from 'react';
import { cn } from 'cn';

type KeyValueEntry = { key: string; label: ReactNode; value: ReactNode };

type KeyValueListProps = Omit<ComponentProps<'dl'>, 'children'> & {
  entries: KeyValueEntry[];
  density?: 'compact' | 'comfortable';
};

export function KeyValueList({
  entries,
  density = 'compact',
  className,
  ...props
}: KeyValueListProps) {
  return (
    <dl
      data-slot="key-value-list"
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs',
        density === 'compact' ? 'gap-y-1' : 'gap-y-2',
        className,
      )}
      {...props}
    >
      {entries.map(entry => (
        <div key={entry.key} className="contents">
          <dt className="leading-5 text-muted-foreground">{entry.label}</dt>
          <dd className="min-w-0 leading-5 [overflow-wrap:anywhere] text-foreground">
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type { KeyValueEntry };
