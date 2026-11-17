import type { ReactNode } from 'react';
import { CircleX, TriangleAlert } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Label } from '@/shared/ui/label';

type FieldMessage = { severity: 'error' | 'warning'; message: string };

type FieldMessagesProps = { id: string; messages: FieldMessage[] };

export function FieldMessages({ id, messages }: FieldMessagesProps) {
  if (!messages.length) return null;
  return (
    <ul id={id} className="space-y-0.5">
      {messages.map(entry => {
        const error = entry.severity === 'error';
        const Icon = error ? CircleX : TriangleAlert;
        return (
          <li
            key={`${entry.severity}:${entry.message}`}
            className={cn(
              'flex items-start gap-1.5 text-2xs leading-4 [overflow-wrap:anywhere]',
              error ? 'text-error-foreground' : 'text-warning-foreground',
            )}
          >
            <Icon
              role="img"
              aria-label={error ? 'Error' : 'Warning'}
              className="mt-0.5 size-3 shrink-0"
            />
            <span className="min-w-0 flex-1">{entry.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

type FieldProps = {
  id: string;
  label: string;
  hint?: ReactNode;
  messages?: FieldMessage[];
  aside?: ReactNode;
  as?: 'label' | 'span';
  layout?: 'stacked' | 'inline';
  className?: string;
  children: ReactNode;
};

export function Field({
  id,
  label,
  hint,
  messages = [],
  aside,
  as = 'label',
  layout = 'stacked',
  className,
  children,
}: FieldProps) {
  const caption =
    as === 'label' ? (
      <Label htmlFor={id} className="text-2xs leading-4 text-muted-foreground">
        {label}
      </Label>
    ) : (
      <span
        id={`${id}-label`}
        className="text-2xs leading-4 font-medium text-muted-foreground"
      >
        {label}
      </span>
    );
  return (
    <div
      data-slot="field"
      data-field={id}
      className={cn(
        layout === 'stacked' && 'space-y-1',
        layout === 'inline' &&
          'grid grid-cols-[minmax(6rem,10rem)_1fr] items-start gap-x-3 gap-y-1',
        className,
      )}
    >
      <div
        className={cn(
          'flex min-h-4 items-center justify-between gap-2',
          layout === 'inline' && 'min-h-7',
        )}
      >
        {caption}
        {aside}
      </div>
      <div className="min-w-0 space-y-1 [&>:has(+select[aria-hidden]:last-child)]:mb-0">
        {children}
        {hint && (
          <p
            id={`${id}-hint`}
            className="text-2xs leading-4 text-muted-foreground"
          >
            {hint}
          </p>
        )}
        <FieldMessages id={`${id}-messages`} messages={messages} />
      </div>
    </div>
  );
}

export type { FieldMessage };
