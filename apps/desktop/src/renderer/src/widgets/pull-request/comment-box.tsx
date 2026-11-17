import type { FormEvent, ReactNode, Ref } from 'react';
import { pullRequestLimits } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
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
  const locked = isActionLocked(state);
  const disabled = !canSubmit || locked || !!blockedReason;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!disabled) onSubmit();
  };
  return (
    <form
      onSubmit={submit}
      className={cn(
        'animate-in duration-base ease-out fade-in-0 slide-in-from-top-0.5',
        className,
      )}
    >
      <Composer variant="compact">
        <ComposerInput
          ref={textareaRef}
          aria-label={label}
          value={value}
          placeholder={placeholder}
          maxLength={pullRequestLimits.commentLength}
          disabled={locked || !!blockedReason}
          autoFocus={autoFocus}
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
        />
        <ComposerToolbar
          className="gap-2"
          start={
            <>
              {controls}
              {blockedReason ? (
                <span className="truncate">{blockedReason}</span>
              ) : (
                <ActionFeedback state={state} />
              )}
            </>
          }
          end={
            <>
              {onCancel && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={locked}
                  onClick={onCancel}
                >
                  Cancel
                </Button>
              )}
              <ComposerSend
                label={submitLabel}
                shortcut="Ctrl Enter"
                pending={state?.status === 'pending'}
                disabled={disabled}
              />
            </>
          }
        />
      </Composer>
    </form>
  );
}
