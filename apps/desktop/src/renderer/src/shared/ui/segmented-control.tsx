import type { KeyboardEvent } from 'react';
import { cn } from 'cn';

type SegmentedOption<T extends string> = { value: T; label: string };

type SegmentedControlProps<T extends string> = {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
};

const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
  const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
  if (!forward && event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') return;
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ':scope > [role="radio"]:not(:disabled)',
    ),
  ];
  const index = radios.findIndex(radio => radio === document.activeElement);
  const next =
    radios[(index + (forward ? 1 : -1) + radios.length) % radios.length];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
};

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={moveSelection}
      className={cn(
        'inline-flex shrink-0 gap-0.5 rounded-lg bg-segment-track p-0.5',
        className,
      )}
    >
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className="inline-flex h-6 items-center rounded-md px-2 text-2xs whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-out outline-none focus-visible:ring-1 focus-visible:ring-ring enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 aria-checked:bg-segment-active aria-checked:text-foreground aria-checked:shadow-xs"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
