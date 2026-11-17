import type { FormEvent, ReactNode } from 'react';
import { pullRequestLimits } from '@nesvo/contracts';
import { cn } from 'cn';
import { Button } from '@/shared/ui/button';
import { ActionFeedback } from './action-feedback';
import type { ActionState } from './use-pull-request-actions';

type CommentBoxProps = {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  submitLabel: string;
  canSubmit: boolean;
  state: ActionState | undefined;
  blockedReason: string;
  onSubmit: () => void;
  onCancel?: () => void;
  controls?: ReactNode;
  autoFocus?: boolean;
  className?: string;
};

export function CommentBox({
  label,
  placeholder,
  value,
  onChange,
  submitLabel,
  canSubmit,
  state,
  blockedReason,
  onSubmit,
  onCancel,
  controls,
  autoFocus = false,
  className,
}: CommentBoxProps) {
  const pending = state?.status === 'pending';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit && !pending && !blockedReason) onSubmit();
  };
  return (
    <form
      onSubmit={submit}
      className={cn(
        'rounded-lg border bg-card transition-colors duration-150 ease-out focus-within:border-ring/60',
        className,
      )}
    >
      <textarea
        aria-label={label}
        value={value}
        placeholder={placeholder}
        maxLength={pullRequestLimits.commentLength}
        disabled={pending || !!blockedReason}
        autoFocus={autoFocus}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (canSubmit && !pending && !blockedReason) onSubmit();
          }
          if (event.key === 'Escape' && onCancel) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        className="field-sizing-content block max-h-60 min-h-16 w-full resize-none bg-transparent px-3 pt-2 text-xs leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        {controls}
        <span className="min-w-0 flex-1">
          {blockedReason ? (
            <span className="text-2xs text-muted-foreground">
              {blockedReason}
            </span>
          ) : (
            <ActionFeedback state={state} />
          )}
        </span>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={onCancel}
            className="text-muted-foreground"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="xs"
          disabled={!canSubmit || pending || !!blockedReason}
          className="disabled:cursor-not-allowed"
        >
          {pending ? 'Sending…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
