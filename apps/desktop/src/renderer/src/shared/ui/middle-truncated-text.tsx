import { cn } from '@/shared/lib/cn';

type Props = { value: string; className?: string };

export function MiddleTruncatedText({ value, className }: Props) {
  const characters = Array.from(value);
  const split = Math.max(
    Math.ceil(characters.length / 2),
    characters.length - 24,
  );
  const head = characters.slice(0, split).join('');
  const tail = characters.slice(split).join('');

  return (
    <span
      dir="ltr"
      data-slot="middle-truncated-text"
      title={value}
      className={cn('flex min-w-0 overflow-hidden', className)}
    >
      <span className="min-w-0 truncate text-left">{head}</span>
      <span className="flex min-w-0 max-w-1/2 shrink-0 justify-end overflow-hidden whitespace-nowrap">
        {tail}
      </span>
    </span>
  );
}
