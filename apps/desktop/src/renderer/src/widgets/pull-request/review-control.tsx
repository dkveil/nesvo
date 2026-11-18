import { useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import type { ReviewDraft, ReviewEvent } from './review-event';
import { ReviewForm } from './review-form';
import { isActionLocked, type ActionState } from './use-pull-request-actions';

type ReviewControlProps = {
  events: ReviewEvent[];
  draft: ReviewDraft;
  blockedReason: string;
  state: ActionState | undefined;
  onDraftChange: (draft: ReviewDraft) => void;
  onSubmit: () => Promise<boolean>;
};

export const ReviewControl = ({
  events,
  draft,
  blockedReason,
  state,
  onDraftChange,
  onSubmit,
}: ReviewControlProps) => {
  const [open, setOpen] = useState(false);
  const locked = isActionLocked(state);
  const submit = async () => {
    if (await onSubmit()) setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (next || !locked) setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs">
          <ClipboardCheck />
          {state?.status === 'pending' ? 'Submitting…' : 'Review'}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        size="lg"
        surface="solid"
        padding="sm"
        aria-label="Submit a review"
      >
        <ReviewForm
          events={events}
          draft={draft}
          blockedReason={blockedReason}
          state={state}
          onChange={onDraftChange}
          onSubmit={() => void submit()}
          onCancel={() => setOpen(false)}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
};
