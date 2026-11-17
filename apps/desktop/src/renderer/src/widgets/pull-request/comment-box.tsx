import type { FormEvent, ReactNode, Ref } from 'react';
import { pullRequestLimits } from '@nesvo/contracts';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { ActionFeedback } from './action-feedback';
import { isActionLocked, type ActionState } from './use-pull-request-actions';

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
  textareaRef?: Ref<HTMLTextAreaElement>;
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
  textareaRef,
  className,
}: CommentBoxProps) {
  const pending = state?.status === 'pending';
  const locked = isActionLocked(state);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit && !locked && !blockedReason) onSubmit();
  };
  const disabled = !canSubmit || locked || !!blockedReason;
  return (
    <form
      onSubmit={submit}
      className={cn(
        'glass-composer animate-in rounded-xl border px-3 pt-2.5 pb-2 duration-150 ease-out fade-in-0 slide-in-from-top-0.5 focus-within:border-input motion-reduce:animate-none',
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        maxLength={pullRequestLimits.commentLength}
        disabled={locked || !!blockedReason}
        autoFocus={autoFocus}
        rows={1}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!disabled) onSubmit();
          }
          if (event.key === 'Escape' && onCancel && !locked) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        className="field-sizing-content block max-h-60 min-h-10 w-full resize-none bg-transparent px-0.5 font-sans text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="mt-1.5 flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-2xs text-muted-foreground">
          {controls}
          {blockedReason ? (
            <span className="truncate">{blockedReason}</span>
          ) : (
            <ActionFeedback state={state} />
          )}
        </span>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={locked}
            onClick={onCancel}
            className="h-6 px-2 text-xs text-muted-foreground enabled:hover:text-foreground"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="icon-sm"
          disabled={disabled}
          aria-label={pending ? 'Sending' : submitLabel}
          title={`${submitLabel} (Ctrl+Enter)`}
          className="size-7 rounded-full disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg]:size-4"
        >
          {pending ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          ) : (
            <ArrowUp />
          )}
        </Button>
      </div>
    </form>
  );
}
