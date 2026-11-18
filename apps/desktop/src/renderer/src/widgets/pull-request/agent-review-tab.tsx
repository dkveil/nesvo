import { useState } from 'react';
import type {
  DesktopApi,
  DesktopReviewDraft,
  PullRequestReference,
  ReviewDraftFinding,
  UpdateReviewFindingInput,
} from '@nesvo/contracts';
import { Bot, ExternalLink, Trash2 } from 'lucide-react';
import {
  SaveRuleDialog,
  StartReviewDialog,
  draftStatusLabels,
  eventLabels,
  useReviewDrafts,
} from '@/features/code-review';
import { RelativeTime } from '@/entities/pull-request';
import { errorDetail } from '@/entities/session';
import { MessageBody } from '@/widgets/conversation/message-body';
import { Badge, type BadgeTone } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { InlineNotice } from '@/shared/ui/inline-notice';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { ReviewFindingCard } from './review-finding-card';
import { ReviewPublishBar } from './review-publish-bar';

export type AgentReviewApi = Pick<
  DesktopApi,
  | 'readCodeReviewSettings'
  | 'startPullRequestReview'
  | 'listPullRequestReviews'
  | 'updateReviewFinding'
  | 'discardPullRequestReview'
  | 'publishPullRequestReview'
  | 'saveReviewConvention'
  | 'subscribe'
>;

type AgentReviewTabProps = {
  api: AgentReviewApi;
  hostId: string;
  reference: PullRequestReference;
  currentHeadSha: string;
  defaultDirectory: string;
  blockedReason: string;
  now: number;
  startRequest: number;
  onOpenSession: (sessionId: string) => void;
  onOpenSettings?: () => void;
};

const statusTones: Record<DesktopReviewDraft['status'], BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  ready: 'success',
  invalid: 'error',
  failed: 'error',
  interrupted: 'warning',
  publishing: 'info',
  published: 'success',
  discarded: 'neutral',
};

const shortSha = (sha: string | null) => sha?.slice(0, 7) ?? '';

export function AgentReviewTab({
  api,
  hostId,
  reference,
  currentHeadSha,
  defaultDirectory,
  blockedReason,
  now,
  startRequest,
  onOpenSession,
  onOpenSettings,
}: AgentReviewTabProps) {
  const drafts = useReviewDrafts({
    api,
    hostId,
    repository: reference.repository,
    number: reference.number,
    enabled: !blockedReason,
  });
  const [starting, setStarting] = useState(startRequest > 0);
  const [selectedId, setSelectedId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [rule, setRule] = useState<ReviewDraftFinding | null>(null);
  const [seenRequest, setSeenRequest] = useState(startRequest);
  if (seenRequest !== startRequest) {
    setSeenRequest(startRequest);
    setStarting(true);
  }
  const visible = drafts.drafts.filter(
    draft => draft.status !== 'discarded' || draft.id === selectedId,
  );
  const draft = visible.find(item => item.id === selectedId) ?? visible[0];
  const editable = draft?.status === 'ready' && !blockedReason;
  const change = async (
    finding: ReviewDraftFinding,
    changes: Omit<
      UpdateReviewFindingInput,
      'draftId' | 'findingId' | 'expectedRevision'
    >,
  ) => {
    if (!draft) return false;
    setPending(true);
    setError('');
    try {
      drafts.upsert(
        await api.updateReviewFinding({
          draftId: draft.id,
          findingId: finding.id,
          expectedRevision: draft.revision,
          ...changes,
        }),
      );
      return true;
    } catch (failure) {
      setError(errorDetail(failure));
      drafts.reload();
      return false;
    } finally {
      setPending(false);
    }
  };
  const discard = async () => {
    if (!draft) return;
    setPending(true);
    setError('');
    try {
      drafts.upsert(
        await api.discardPullRequestReview({
          draftId: draft.id,
          expectedRevision: draft.revision,
        }),
      );
      setSelectedId('');
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  const startButton = (
    <Button
      type="button"
      size="sm"
      variant={draft ? 'ghost' : 'default'}
      disabled={!!blockedReason}
      onClick={() => setStarting(true)}
    >
      <Bot />
      Review with agent
    </Button>
  );
  const headMoved =
    !!draft?.headSha &&
    !!currentHeadSha &&
    draft.headSha !== currentHeadSha &&
    draft.status !== 'published';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {blockedReason ? (
          <InlineNotice>{blockedReason}</InlineNotice>
        ) : drafts.status === 'loading' && !drafts.drafts.length ? (
          <SkeletonList label="Loading agent reviews" rows={3} />
        ) : drafts.status === 'error' && !drafts.drafts.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <InlineNotice tone="error" className="min-w-0 flex-1">
              {drafts.error}
            </InlineNotice>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={drafts.reload}
            >
              Try again
            </Button>
          </div>
        ) : !draft ? (
          <EmptyState
            size="sm"
            icon={Bot}
            title="No agent review yet"
            description="An agent reads the checked out pull request and drafts findings. You decide what gets published."
            action={startButton}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {visible.length > 1 ? (
                <Select value={draft.id} onValueChange={setSelectedId}>
                  <SelectTrigger
                    variant="ghost"
                    size="sm"
                    aria-label="Agent review"
                    className="max-w-64"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {visible.map(item => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.profile.name} · {draftStatusLabels[item.status]} ·{' '}
                        {shortSha(item.headSha)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-xs font-medium">
                  {draft.profile.name}
                </span>
              )}
              <Badge size="xs" tone={statusTones[draft.status]}>
                {draftStatusLabels[draft.status]}
              </Badge>
              <span className="text-2xs text-muted-foreground">
                {draft.profile.provider}
                {draft.profile.model === 'default'
                  ? ''
                  : ` · ${draft.profile.model}`}{' '}
                · <span className="font-mono">{shortSha(draft.headSha)}</span> ·{' '}
                <RelativeTime at={draft.createdAt} now={now} />
              </span>
              <span className="ml-auto flex items-center gap-1">
                {draft.sessionId && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenSession(draft.sessionId!)}
                  >
                    <ExternalLink />
                    Open session
                  </Button>
                )}
                {draft.status !== 'running' &&
                  draft.status !== 'publishing' &&
                  draft.status !== 'published' &&
                  draft.status !== 'discarded' && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => void discard()}
                    >
                      <Trash2 />
                      Discard draft
                    </Button>
                  )}
                {startButton}
              </span>
            </div>
            {(draft.status === 'queued' || draft.status === 'running') && (
              <StatusMessage tone="loading">
                {draft.status === 'queued'
                  ? 'Waiting for the host to finish other work…'
                  : 'The agent is reviewing the checkout. The draft appears here when it finishes.'}
              </StatusMessage>
            )}
            {(draft.status === 'failed' ||
              draft.status === 'invalid' ||
              draft.status === 'interrupted') &&
              draft.error && (
                <InlineNotice
                  tone={draft.status === 'interrupted' ? 'warning' : 'error'}
                >
                  {draft.error}
                </InlineNotice>
              )}
            {draft.status === 'ready' && draft.error && (
              <InlineNotice tone="warning">{draft.error}</InlineNotice>
            )}
            {draft.status === 'published' && draft.published && (
              <InlineNotice tone="success">
                Published as {eventLabels[draft.published.event]} ·{' '}
                {draft.published.inline} line{' '}
                {draft.published.inline === 1 ? 'comment' : 'comments'},{' '}
                {draft.published.inBody} in the review body
                {draft.published.headMoved
                  ? ' (the pull request had moved past the reviewed commit)'
                  : ''}
                .
              </InlineNotice>
            )}
            {headMoved && (
              <InlineNotice tone="warning">
                The pull request has new commits since this review. Publishing
                stays bound to {shortSha(draft.headSha)}; start a new review to
                cover the latest changes.
              </InlineNotice>
            )}
            {draft.summary && (
              <div className="rounded-surface border bg-card px-3 py-2">
                <p className="mb-1 text-2xs font-medium text-muted-foreground">
                  Summary
                </p>
                <MessageBody
                  body={draft.summary}
                  className="text-xs leading-5"
                />
              </div>
            )}
            {draft.status === 'ready' &&
              !draft.findings.length &&
              !draft.summary && (
                <StatusMessage tone="success">
                  The agent found nothing to report.
                </StatusMessage>
              )}
            {draft.filtered > 0 && (
              <p className="text-2xs text-muted-foreground">
                {draft.filtered} more{' '}
                {draft.filtered === 1 ? 'finding was' : 'findings were'} left
                out by the profile’s types, severity or limit.
              </p>
            )}
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
            <div className="space-y-2">
              {draft.findings.map(finding => (
                <ReviewFindingCard
                  key={`${finding.id}:${draft.revision}`}
                  finding={finding}
                  editable={editable}
                  pending={pending}
                  onChange={changes => change(finding, changes)}
                  onSaveRule={setRule}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {draft?.status === 'ready' && (
        <ReviewPublishBar
          key={draft.id}
          api={api}
          draft={draft}
          blockedReason={blockedReason}
          onPublished={drafts.upsert}
        />
      )}
      {starting && (
        <StartReviewDialog
          open
          onOpenChange={setStarting}
          api={api}
          hostId={hostId}
          references={[reference]}
          defaultDirectory={defaultDirectory}
          onStarted={started => {
            for (const item of started) drafts.upsert(item);
            if (started[0]) setSelectedId(started[0].id);
          }}
          onOpenSettings={onOpenSettings}
        />
      )}
      {rule && (
        <SaveRuleDialog
          api={api}
          repository={reference.repository}
          path={rule.path}
          initialText={
            rule.state === 'discarded'
              ? `Do not report: ${rule.body}`
              : rule.body
          }
          onSaved={() => undefined}
          onClose={() => setRule(null)}
        />
      )}
    </div>
  );
}
