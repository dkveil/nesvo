import type { ReactNode } from 'react';

type Props = {
  id: string;
  usage: ReactNode;
};

export function ThreadDetails({ id, usage }: Props) {
  return (
    <aside
      id={id}
      aria-label="Thread details"
      className="absolute top-2 right-3 z-20 w-58 rounded-xl border bg-card p-1.5 text-card-foreground shadow-(--popover-shadow)"
    >
      <section aria-labelledby={`${id}-usage`} className="space-y-1 p-1">
        <h2
          id={`${id}-usage`}
          className="px-1.5 text-2xs font-medium text-muted-foreground"
        >
          Usage
        </h2>
        {usage}
      </section>
    </aside>
  );
}
