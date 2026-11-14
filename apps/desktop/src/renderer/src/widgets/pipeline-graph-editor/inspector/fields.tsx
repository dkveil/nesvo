import type { KeyboardEvent, ReactNode } from 'react';
import { CircleX, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { Label } from '@/shared/ui/label';
import { notesId, type FieldNote } from './field-notes';

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
};

type SegmentedProps<T extends string> = {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  disabled?: boolean;
  describedBy?: string;
  invalid?: boolean;
  toggle?: boolean;
  onChange: (value: T) => void;
};

const moveSelection = <T extends string>(
  event: KeyboardEvent<HTMLDivElement>,
  options: SegmentOption<T>[],
  value: T,
  onChange: (value: T) => void,
) => {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  if (!forward && !backward) return;
  event.preventDefault();
  const enabled = options.filter(option => !option.disabled);
  const index = enabled.findIndex(option => option.value === value);
  const offset = forward ? 1 : -1;
  const next = enabled[(index + offset + enabled.length) % enabled.length];
  if (!next) return;
  onChange(next.value);
  event.currentTarget
    .querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)
    ?.focus();
};

export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled = false,
  describedBy,
  invalid = false,
  toggle = false,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div
      role={toggle ? 'group' : 'radiogroup'}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-disabled={disabled || undefined}
      onKeyDown={event => {
        if (!disabled && !toggle)
          moveSelection(event, options, value, onChange);
      }}
      className={cn(
        'flex w-full gap-0.5 rounded-lg bg-segment-track p-0.5',
        invalid && 'ring-1 ring-destructive',
      )}
    >
      {options.map(option => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={toggle ? undefined : 'radio'}
            data-value={option.value}
            aria-checked={toggle ? undefined : checked}
            aria-pressed={toggle ? checked : undefined}
            tabIndex={toggle || checked ? 0 : -1}
            title={option.title}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-6 min-w-0 flex-auto items-center justify-center rounded-md px-1.5 text-2xs text-muted-foreground transition-colors duration-100 outline-none',
              'enabled:hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              'aria-checked:bg-segment-active aria-checked:text-foreground aria-pressed:bg-segment-active aria-pressed:text-foreground',
            )}
          >
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FieldNotes({ id, notes }: { id: string; notes: FieldNote[] }) {
  if (!notes.length) return null;
  return (
    <ul id={id} className="space-y-0.5">
      {notes.map(note => {
        const error = note.severity === 'error';
        const Icon = error ? CircleX : TriangleAlert;
        return (
          <li
            key={`${note.severity}:${note.message}`}
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
            <span className="min-w-0 flex-1">{note.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

type FieldProps = {
  id: string;
  label: string;
  notes?: FieldNote[];
  hint?: ReactNode;
  aside?: ReactNode;
  as?: 'label' | 'span';
  children: ReactNode;
};

export function Field({
  id,
  label,
  notes = [],
  hint,
  aside,
  as = 'label',
  children,
}: FieldProps) {
  return (
    <div className="space-y-1" data-field={id}>
      <div className="flex min-h-4 items-center justify-between gap-2">
        {as === 'label' ? (
          <Label htmlFor={id} className="text-2xs text-muted-foreground">
            {label}
          </Label>
        ) : (
          <span
            id={`${id}-label`}
            className="text-2xs leading-none font-medium text-muted-foreground"
          >
            {label}
          </span>
        )}
        {aside}
      </div>
      {children}
      {hint && (
        <p className="text-2xs leading-4 text-muted-foreground">{hint}</p>
      )}
      <FieldNotes id={notesId(id)} notes={notes} />
    </div>
  );
}
