import type { KeyboardEvent, ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
  disabled?: boolean;
  title?: string;
};

type SegmentedBaseProps<T extends string> = {
  label: string;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  iconOnly?: boolean;
  orientation?: 'horizontal' | 'vertical';
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
};

type SegmentedSingleProps<T extends string> = SegmentedBaseProps<T> & {
  mode?: 'single' | 'toggle';
  value: T | null;
  onChange: (value: T) => void;
};

type SegmentedMultipleProps<T extends string> = SegmentedBaseProps<T> & {
  mode: 'multiple';
  value: T[];
  onChange: (value: T[]) => void;
};

type SegmentedControlProps<T extends string> =
  SegmentedSingleProps<T> | SegmentedMultipleProps<T>;

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

export function SegmentedControl<T extends string>(
  props: SegmentedControlProps<T>,
) {
  const {
    label,
    options,
    size = 'sm',
    fullWidth = false,
    iconOnly = false,
    orientation = 'horizontal',
    disabled = false,
    invalid = false,
    describedBy,
    className,
  } = props;
  const mode = props.mode ?? 'single';
  const radio = mode === 'single';
  const isOn = (value: T) =>
    props.mode === 'multiple'
      ? props.value.includes(value)
      : props.value === value;
  const tabStop =
    options.find(option => isOn(option.value))?.value ??
    options.find(option => !option.disabled)?.value;
  const choose = (value: T) => {
    if (props.mode === 'multiple')
      props.onChange(
        props.value.includes(value)
          ? props.value.filter(entry => entry !== value)
          : [...props.value, value],
      );
    else props.onChange(value);
  };
  return (
    <div
      role={radio ? 'radiogroup' : 'group'}
      aria-label={label}
      aria-orientation={radio ? orientation : undefined}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-disabled={disabled || undefined}
      data-size={size}
      onKeyDown={event => {
        if (radio && !disabled) moveSelection(event);
      }}
      className={cn(
        'inline-flex shrink-0 gap-0.5 rounded-surface bg-segment-track p-0.5',
        fullWidth && 'flex w-full',
        orientation === 'vertical' && 'flex-col',
        invalid && 'outline-1 outline-error-foreground',
        className,
      )}
    >
      {options.map(option => {
        const on = isOn(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role={radio ? 'radio' : undefined}
            data-value={option.value}
            data-selected={on ? '' : undefined}
            aria-checked={radio ? on : undefined}
            aria-pressed={radio ? undefined : on}
            aria-label={iconOnly ? option.label : undefined}
            tabIndex={radio && option.value !== tabStop ? -1 : 0}
            title={option.title}
            disabled={disabled || option.disabled}
            onClick={() => choose(option.value)}
            className={cn(
              'focus-ring inline-flex min-w-0 items-center justify-center gap-1.5 rounded-control whitespace-nowrap text-muted-foreground transition-[color,background-color] duration-fast ease-out [&_svg]:shrink-0',
              size === 'sm' &&
                'h-6 px-2 text-2xs [&_svg:not([class*=size-])]:size-3',
              size === 'md' &&
                'h-7 px-2.5 text-xs [&_svg:not([class*=size-])]:size-3.5',
              iconOnly && (size === 'sm' ? 'w-6 px-0' : 'w-7 px-0'),
              fullWidth && 'flex-auto',
              'enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
              'data-selected:bg-segment-active data-selected:text-foreground data-selected:shadow-xs',
            )}
          >
            {option.icon}
            {!iconOnly && <span className="truncate">{option.label}</span>}
            {option.count != null && !iconOnly && (
              <span className="text-micro text-muted-foreground tabular-nums">
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type { SegmentedOption };
