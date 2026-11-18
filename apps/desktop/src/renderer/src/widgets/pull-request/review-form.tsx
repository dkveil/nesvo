import { SegmentedControl } from '@/shared/ui/segmented-control';
import { CommentBox } from './comment-box';
import {
  reviewEventLabels,
  type ReviewDraft,
  type ReviewEvent,
} from './review-event';
import { isActionLocked, type ActionState } from './use-pull-request-actions';

type ReviewFormProps = {
  events: ReviewEvent[];
  draft: ReviewDraft;
  blockedReason: string;
  state: ActionState | undefined;
  onChange: (draft: ReviewDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
};

export const ReviewForm = ({
  events,
  draft,
  blockedReason,
  state,
  onChange,
  onSubmit,
  onCancel,
  autoFocus = false,
}: ReviewFormProps) => (
  <div className="space-y-2">
    {events.length > 1 && (
      <SegmentedControl
        label="Review decision"
        value={draft.event}
        options={events.map(value => ({
          value,
          label: reviewEventLabels[value],
        }))}
        onChange={event => onChange({ ...draft, event })}
        disabled={isActionLocked(state)}
        fullWidth
      />
    )}
    <CommentBox
      label="Review comment"
      placeholder={
        draft.event === 'approve'
          ? 'Optional note with the approval'
          : 'Leave a review comment'
      }
      value={draft.body}
      onChange={body => onChange({ ...draft, body })}
      submitLabel={`Submit review: ${reviewEventLabels[draft.event]}`}
      canSubmit={draft.event === 'approve' || !!draft.body.trim()}
      state={state}
      blockedReason={blockedReason}
      onSubmit={onSubmit}
      onCancel={onCancel}
      autoFocus={autoFocus}
    />
  </div>
);
