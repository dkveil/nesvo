import type { FormEvent, ReactNode } from 'react';
import { codeCommentLimits } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { Composer, ComposerInput, ComposerToolbar } from '@/shared/ui/composer';
import { Kbd } from '@/shared/ui/kbd';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { Spinner } from '@/shared/ui/spinner';

export type CodeCommentTarget = 'agent' | 'review';

export type CodeCommentTargetOption = {
  value: CodeCommentTarget;
  label: string;
  blockedReason: string;
};

type CodeCommentFormProps = {
  location: string;
  value: string;
  targets: readonly CodeCommentTargetOption[];
  target: CodeCommentTarget;
  pending?: boolean;
  feedback?: ReactNode;
  onChange: (value: string) => void;
  onTargetChange: (target: CodeCommentTarget) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function CodeCommentForm({
  location,
  value,
  targets,
  target,
  pending = false,
  feedback,
  onChange,
  onTargetChange,
  onSubmit,
  onCancel,
}: CodeCommentFormProps) {
  const selected = targets.find(option => option.value === target);
  const blockedReason = selected?.blockedReason ?? '';
  const disabled = !value.trim() || pending || !!blockedReason || !selected;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!disabled) onSubmit();
  };
  return (
    <form
      data-diff-comment
      onSubmit={submit}
      className="my-1.5 animate-in duration-base ease-out fade-in-0 slide-in-from-top-0.5"
    >
      <Composer variant="compact">
        <ComposerInput
          aria-label={`Comment on ${location}`}
          value={value}
          placeholder="Add a comment…"
          maxLength={codeCommentLimits.bodyLength}
          disabled={pending}
          autoFocus
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape' && !pending) {
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
              {targets.length > 1 && (
                <SegmentedControl
                  label="Comment destination"
                  size="sm"
                  options={targets.map(option => ({
                    value: option.value,
                    label: option.label,
                    tooltip: option.blockedReason || undefined,
                  }))}
                  value={target}
                  onChange={onTargetChange}
                />
              )}
              {blockedReason ? (
                <span className="truncate">{blockedReason}</span>
              ) : (
                (feedback ?? (
                  <span className="hidden truncate sm:inline">
                    <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd> to submit
                  </span>
                ))
              )}
            </>
          }
          end={
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={pending}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button type="submit" size="xs" disabled={disabled}>
                {pending && <Spinner className="text-current" />}
                {selected?.label ?? 'Comment'}
              </Button>
            </>
          }
        />
      </Composer>
    </form>
  );
}
