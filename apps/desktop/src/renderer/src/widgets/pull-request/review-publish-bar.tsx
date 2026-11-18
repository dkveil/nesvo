import { useState } from 'react';
import {
  codeReviewLimits,
  type DesktopApi,
  type DesktopReviewDraft,
  type ReviewEvent,
} from '@nesvo/contracts';
import { Send } from 'lucide-react';
import { eventLabels } from '@/features/code-review';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { DisabledHint } from '@/shared/ui/disabled-hint';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';
import { isOutcomeUnknown, OUTCOME_UNKNOWN_MESSAGE } from './outcome';

const EVENTS: ReviewEvent[] = ['comment', 'request-changes', 'approve'];

type Submission = {
  actionId: string;
  event: ReviewEvent;
  body: string;
  allowMovedHead: boolean;
};

type ReviewPublishBarProps = {
  api: Pick<DesktopApi, 'publishPullRequestReview'>;
  draft: DesktopReviewDraft;
  blockedReason: string;
  onPublished: (draft: DesktopReviewDraft) => void;
};

const shortSha = (sha: string) => sha.slice(0, 7);

export function ReviewPublishBar({
  api,
  draft,
  blockedReason,
  onPublished,
}: ReviewPublishBarProps) {
  const [event, setEvent] = useState<ReviewEvent>('comment');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [movedTo, setMovedTo] = useState('');
  const [submission, setSubmission] = useState<Submission | null>(null);
  const kept = draft.findings.filter(finding => finding.state === 'kept');
  const undecided = draft.findings.filter(
    finding => finding.state === 'pending',
  ).length;
  const reason =
    blockedReason ||
    (!kept.length && !body.trim() && event !== 'approve'
      ? 'Keep at least one finding or write a review comment.'
      : '');
  const send = async (next: Submission) => {
    setSubmission(next);
    setPending(true);
    setError('');
    setUnknown(false);
    try {
      const result = await api.publishPullRequestReview({
        draftId: draft.id,
        actionId: next.actionId,
        expectedRevision: draft.revision,
        event: next.event,
        body: next.body,
        allowMovedHead: next.allowMovedHead,
      });
      setSubmission(null);
      if (result.status === 'head-moved') {
        setMovedTo(result.currentHeadSha);
        return;
      }
      onPublished(result.draft);
    } catch (failure) {
      if (isOutcomeUnknown(failure)) {
        setUnknown(true);
        return;
      }
      setSubmission(null);
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  const publish = (allowMovedHead: boolean) =>
    send({
      actionId: crypto.randomUUID(),
      event,
      body: body.trim(),
      allowMovedHead,
    });
  return (
    <section
      aria-label="Publish review"
      className="shrink-0 space-y-2 border-t bg-background px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label="Review decision"
          size="sm"
          value={event}
          options={EVENTS.map(value => ({ value, label: eventLabels[value] }))}
          onChange={setEvent}
          disabled={pending || unknown}
        />
        <span className="text-2xs text-muted-foreground tabular-nums">
          {kept.length} kept
          {undecided ? ` · ${undecided} not decided` : ''}
        </span>
      </div>
      <Textarea
        aria-label="Review comment"
        size="sm"
        rows={2}
        value={body}
        maxLength={codeReviewLimits.reviewBody}
        placeholder="Optional overall comment"
        disabled={pending || unknown}
        onChange={event => setBody(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {error && (
          <StatusMessage tone="error" className="mr-auto">
            {error}
          </StatusMessage>
        )}
        {unknown && submission && (
          <StatusMessage tone="warning" className="mr-auto">
            {OUTCOME_UNKNOWN_MESSAGE}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-1"
              onClick={() => void send(submission)}
            >
              Retry with the same request
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setSubmission(null);
                setUnknown(false);
              }}
            >
              Discard
            </Button>
          </StatusMessage>
        )}
        <DisabledHint reason={reason}>
          <Button
            type="button"
            size="sm"
            disabled={!!reason || pending || unknown}
            aria-busy={pending || undefined}
            onClick={() => void publish(false)}
          >
            <Send />
            {pending
              ? 'Publishing…'
              : kept.length
                ? `Publish ${kept.length} ${kept.length === 1 ? 'finding' : 'findings'}`
                : 'Publish review'}
          </Button>
        </DisabledHint>
      </div>
      <ConfirmDialog
        open={!!movedTo}
        onOpenChange={open => {
          if (!open) setMovedTo('');
        }}
        title="The pull request has new commits"
        description={`This draft reviewed ${shortSha(draft.headSha ?? '')}; the pull request is now at ${shortSha(movedTo)}. Publishing keeps the review bound to the reviewed commit and moves every finding into the review body. Start a new review to cover the latest changes.`}
        confirmLabel="Publish anyway"
        pendingLabel="Publishing…"
        tone="default"
        onConfirm={async () => {
          await publish(true);
          return true;
        }}
      />
    </section>
  );
}
