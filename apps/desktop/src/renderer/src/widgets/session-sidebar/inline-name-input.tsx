import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';

type Props = {
  value: string;
  label: string;
  maxLength: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  className?: string;
};

export function InlineNameInput({
  value,
  label,
  maxLength,
  onSubmit,
  onCancel,
  className,
}: Props) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = draft.trim();
    if (save && next && next !== value) onSubmit(next);
    else onCancel();
  };
  return (
    <input
      ref={input}
      type="text"
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      onChange={event => setDraft(event.target.value)}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cn(
        'h-5 min-w-0 flex-1 rounded-sm bg-sidebar-row-selected px-1 text-xs font-medium text-sidebar-foreground ring-1 ring-ring outline-none',
        className,
      )}
    />
  );
}
