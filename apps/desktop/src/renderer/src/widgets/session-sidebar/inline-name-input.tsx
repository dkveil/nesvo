import { useEffect, useRef, useState } from 'react';
import { Input } from '@/shared/ui/input';

type Props = {
  value: string;
  label: string;
  maxLength: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

export function InlineNameInput({
  value,
  label,
  maxLength,
  onSubmit,
  onCancel,
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
    <Input
      ref={input}
      variant="ghost"
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      className="h-auto text-xs font-medium text-sidebar-foreground"
      onChange={event => setDraft(event.target.value)}
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
    />
  );
}
