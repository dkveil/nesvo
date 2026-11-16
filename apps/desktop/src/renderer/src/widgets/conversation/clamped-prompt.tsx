import { useState, type ReactNode } from 'react';
import { cn } from 'cn';

type Props = { children: ReactNode };

export function ClampedPrompt({ children }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex max-w-[85%] min-w-0 flex-col items-end gap-1">
      <div
        className={cn(
          'relative w-full',
          !expanded && 'max-h-48 overflow-hidden',
        )}
      >
        {children}
        {!expanded && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-2xl bg-linear-to-t from-message-surface to-transparent"
          />
        )}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        className="text-xs text-muted-foreground hover:text-foreground focus-visible:underline"
        onClick={() => setExpanded(value => !value)}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}
