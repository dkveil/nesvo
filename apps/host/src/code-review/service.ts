import { createHash, randomUUID } from 'node:crypto';
import {
  AGENT_REVIEW_BRANCH_PREFIX,
  agentReviewOutputJsonSchema,
  codeReviewLimits,
  type CodeReviewSettings,
  type DesktopEvent,
  type PullRequestFiles,
  type PullRequestReference,
  type ReviewConvention,
  type ReviewDraft,
  type ReviewerProfile,
  type ScheduledJob,
  type Session,
} from '@nesvo/contracts';
import type { z } from 'zod';
import type {
  deleteReviewConventionSchema,
  deleteReviewerProfileSchema,
  discardPullRequestReviewSchema,
  listPullRequestReviewsSchema,
  publishPullRequestReviewSchema,
  saveReviewConventionSchema,
  saveReviewerProfileSchema,
  startPullRequestReviewSchema,
  updateReviewFindingSchema,
} from '@nesvo/contracts';
import { PullRequestError } from '../process/github-cli';
import type { PullRequests } from '../pull-requests';
import { SessionError } from '../sessions/session-error';
import type { RunOutcome, SessionService } from '../sessions/service';
import { FolderError } from '../workspace/folder';
import {
  WorkspaceIsolationError,
  readHeadCommit,
} from '../workspace/isolation';
import { buildSubmission, parseAgentFindings } from './findings';
import { reviewPrompt } from './prompt';
import type { CodeReviewStore } from './store';

const FOLDER_WAIT_MS = 10 * 60_000;
const TITLE_LENGTH = 100;

type ReviewSessions = Pick<
  SessionService,
  | 'createWithEffort'
  | 'linkPullRequest'
  | 'withPullRequestCheckout'
  | 'send'
  | 'finished'
  | 'whenFolderFree'
  | 'onRunFinished'
>;

type ReviewPullRequests = Pick<
  PullRequests,
  'reviewTarget' | 'files' | 'act' | 'checkoutDetached' | 'openReviewTargets'
>;

export class CodeReviewError extends Error {
  constructor(
    readonly code: 'busy' | 'not-found' | 'invalid-request' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'CodeReviewError';
  }
}

export const derivedId = (kind: string, id: string): string => {
  const hex = createHash('sha256').update(`${kind}:${id}`).digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const failureMessage = (error: unknown) =>
  (error instanceof PullRequestError ||
  error instanceof SessionError ||
  error instanceof FolderError ||
  error instanceof WorkspaceIsolationError ||
  error instanceof CodeReviewError
    ? error.message
    : 'The review could not be prepared.'
  ).slice(0, codeReviewLimits.error);

const OUTCOME_MESSAGES = {
  failed: 'The review session failed.',
  stopped: 'The review session was stopped.',
  interrupted: 'The review session was interrupted.',
} as const;

const sessionTitle = (reference: PullRequestReference, title: string) =>
  `Review #${reference.number} · ${title}`.slice(0, TITLE_LENGTH);

const profileSnapshot = (
  profile: ReviewerProfile,
): ReviewDraft['profile'] => ({
  id: profile.id,
  name: profile.name,
  provider: profile.provider,
  model: profile.model,
  effort: profile.effort,
  findingTypes: profile.findingTypes,
  minimumSeverity: profile.minimumSeverity,
  maxFindings: profile.maxFindings,
  tone: profile.tone,
  language: profile.language,
  includeSummary: profile.includeSummary,
});

type StartReview = z.output<typeof startPullRequestReviewSchema> & {
  scheduledJobId?: string | null;
};

export class CodeReviews {
  private readonly controller = new AbortController();
  private running: Promise<void> | null = null;
  private readonly releaseRunListener: () => void;
  private closed = false;
  private readonly descriptions = new Map<string, string>();
  private readonly pendingStarts = new Map<string, Promise<ReviewDraft>>();

  constructor(
    private readonly store: CodeReviewStore,
    private readonly sessions: ReviewSessions,
    private readonly pullRequests: ReviewPullRequests,
    private readonly emit: (event: DesktopEvent) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.recover();
    this.releaseRunListener = sessions.onRunFinished(() => this.pump());
  }

  settings(): CodeReviewSettings {
    return {
      profiles: this.store.profiles(),
      conventions: this.store.conventions(),
    };
  }

  saveProfile(
    input: z.output<typeof saveReviewerProfileSchema>,
  ): CodeReviewSettings {
    const { id, expectedRevision, ...definition } = input;
    const current = this.store.profile(id);
    if (expectedRevision === null) {
      if (current)
        throw new CodeReviewError(
          'invalid-request',
          'This reviewer profile already exists. Refresh and try again.',
        );
      if (this.store.profileCount() >= codeReviewLimits.profiles)
        throw new CodeReviewError(
          'invalid-request',
          `This computer already has ${codeReviewLimits.profiles} reviewer profiles.`,
        );
    } else if (!current) {
      throw new CodeReviewError('not-found', 'Reviewer profile not found.');
    }
    const at = this.now().toISOString();
    const saved = this.store.saveProfile(
      {
        ...definition,
        id,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? at,
        updatedAt: at,
      },
      expectedRevision,
    );
    if (!saved)
      throw new CodeReviewError(
        'invalid-request',
        'This reviewer profile changed elsewhere. Reload it and try again.',
      );
    return this.settings();
  }

  deleteProfile(
    input: z.output<typeof deleteReviewerProfileSchema>,
  ): CodeReviewSettings {
    if (!this.store.deleteProfile(input.id, input.expectedRevision))
      throw new CodeReviewError(
        'invalid-request',
        'This reviewer profile changed or was removed. Reload and try again.',
      );
    return this.settings();
  }

  saveConvention(
    input: z.output<typeof saveReviewConventionSchema>,
  ): CodeReviewSettings {
    const current = this.store.convention(input.id);
    if (!current && this.store.conventionCount() >= codeReviewLimits.conventions)
      throw new CodeReviewError(
        'invalid-request',
        `This computer already has ${codeReviewLimits.conventions} review conventions.`,
      );
    const at = this.now().toISOString();
    const convention: ReviewConvention = {
      ...input,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
    };
    this.store.saveConvention(convention);
    return this.settings();
  }

  deleteConvention(
    input: z.output<typeof deleteReviewConventionSchema>,
  ): CodeReviewSettings {
    if (!this.store.deleteConvention(input.id))
      throw new CodeReviewError('not-found', 'Review convention not found.');
    return this.settings();
  }

  list(input: z.output<typeof listPullRequestReviewsSchema>): ReviewDraft[] {
    return this.store.drafts(input.reference);
  }

  start(input: StartReview): Promise<ReviewDraft> {
    const pending = this.pendingStarts.get(input.requestId);
    if (pending) return pending;
    const started = this.startConfirmed(input).finally(() =>
      this.pendingStarts.delete(input.requestId),
    );
    this.pendingStarts.set(input.requestId, started);
    return started;
  }

  private async startConfirmed(input: StartReview): Promise<ReviewDraft> {
    const existing = this.store.draftForRequest(input.requestId);
    if (existing) return existing;
    const profile = this.store.profile(input.profileId);
    if (!profile)
      throw new CodeReviewError(
        'not-found',
        'Reviewer profile not found. Choose another profile.',
      );
    const target = await this.pullRequests.reviewTarget(input.reference);
    if (target.state.toUpperCase() !== 'OPEN')
      throw new CodeReviewError(
        'invalid-request',
        'Only open pull requests can be reviewed.',
      );
    const at = this.now().toISOString();
    const draft: ReviewDraft = {
      id: randomUUID(),
      revision: 1,
      reference: input.reference,
      title: target.title,
      directory: input.directory,
      profile: profileSnapshot(profile),
      sessionId: null,
      scheduledJobId: input.scheduledJobId ?? null,
      headSha: target.headRefOid,
      status: 'queued',
      error: null,
      summary: null,
      findings: [],
      filtered: 0,
      published: null,
      createdAt: at,
      updatedAt: at,
    };
    this.store.insertDraft(draft, input.requestId);
    this.descriptions.set(draft.id, target.body);
    this.announce(draft);
    this.pump();
    return draft;
  }

  async startForAutomation(
    job: Pick<ScheduledJob, 'id' | 'directory' | 'pullRequestReview'>,
    runId: string,
  ): Promise<number> {
    if (!job.pullRequestReview) return 0;
    const { repository, items } = await this.pullRequests.openReviewTargets(
      job.directory,
    );
    let started = 0;
    for (const item of items) {
      if (started >= codeReviewLimits.automationReviews) break;
      const reference = { repository, number: item.number };
      const latest = this.store.drafts(reference)[0];
      if (latest?.headSha === item.headRefOid) continue;
      await this.start({
        requestId: derivedId(`automation:${runId}`, `${item.number}`),
        reference,
        directory: job.directory,
        profileId: job.pullRequestReview.profileId,
        scheduledJobId: job.id,
      });
      started++;
    }
    return started;
  }

  updateFinding(
    input: z.output<typeof updateReviewFindingSchema>,
  ): ReviewDraft {
    const draft = this.current(input.draftId, input.expectedRevision);
    if (draft.status !== 'ready')
      throw new CodeReviewError(
        'invalid-request',
        'Only a ready draft review can be edited.',
      );
    const finding = draft.findings.find(item => item.id === input.findingId);
    if (!finding)
      throw new CodeReviewError('not-found', 'Finding not found.');
    const edited =
      (input.body !== undefined && input.body !== finding.body) ||
      (input.suggestion !== undefined &&
        input.suggestion !== finding.suggestion) ||
      (input.severity !== undefined && input.severity !== finding.severity) ||
      (input.type !== undefined && input.type !== finding.type);
    const type = input.type ?? finding.type;
    const next = {
      ...finding,
      state: input.state ?? (edited ? 'kept' : finding.state),
      body: input.body ?? finding.body,
      severity: input.severity ?? finding.severity,
      type,
      suggestion:
        type === 'suggestion'
          ? input.suggestion === undefined
            ? finding.suggestion
            : input.suggestion
          : null,
      edited: finding.edited || edited,
    };
    return this.replace(draft, {
      findings: draft.findings.map(item =>
        item.id === finding.id ? next : item,
      ),
      error: null,
    });
  }

  discard(input: z.output<typeof discardPullRequestReviewSchema>): ReviewDraft {
    const draft = this.current(input.draftId, input.expectedRevision);
    if (
      draft.status === 'running' ||
      draft.status === 'publishing' ||
      draft.status === 'published'
    )
      throw new CodeReviewError(
        'invalid-request',
        draft.status === 'running'
          ? 'Stop the review session before discarding its draft.'
          : 'A published review cannot be discarded.',
      );
    if (draft.status === 'discarded') return draft;
    return this.replace(draft, { status: 'discarded', error: null });
  }

  async publish(input: z.output<typeof publishPullRequestReviewSchema>) {
    const stored = this.store.draft(input.draftId);
    if (!stored)
      throw new CodeReviewError('not-found', 'Draft review not found.');
    if (stored.published?.actionId === input.actionId)
      return { status: 'published' as const, draft: stored };
    if (stored.status === 'published')
      throw new CodeReviewError(
        'invalid-request',
        'This draft review was already published.',
      );
    if (stored.status === 'publishing')
      throw new CodeReviewError(
        'busy',
        'This draft review is being published. Wait for the result.',
      );
    const draft = this.current(input.draftId, input.expectedRevision);
    if (draft.status !== 'ready' || !draft.headSha)
      throw new CodeReviewError(
        'invalid-request',
        'Only a ready draft review can be published.',
      );
    const kept = draft.findings.filter(finding => finding.state === 'kept');
    if (!kept.length && !input.body && input.event !== 'approve')
      throw new CodeReviewError(
        'invalid-request',
        'Keep at least one finding or write a review comment.',
      );
    const current = await this.pullRequests.files(draft.reference);
    const headMoved = current.headSha !== draft.headSha;
    if (headMoved && !input.allowMovedHead)
      return {
        status: 'head-moved' as const,
        currentHeadSha: current.headSha,
        draft,
      };
    const submission = buildSubmission(
      draft,
      input.body,
      headMoved ? null : current.files,
    );
    const body =
      submission.body ||
      (input.event === 'approve'
        ? ''
        : 'Review findings are attached to the changed lines.');
    const publishing = this.replace(draft, {
      status: 'publishing',
      error: null,
    });
    try {
      await this.pullRequests.act({
        actionId: input.actionId,
        reference: draft.reference,
        action: {
          action: 'submit-review',
          event: input.event,
          commitId: draft.headSha,
          body,
          comments: submission.comments,
        },
      });
    } catch (error) {
      this.replace(publishing, {
        status: 'ready',
        error: failureMessage(error),
      });
      throw error;
    }
    return {
      status: 'published' as const,
      draft: this.replace(publishing, {
        status: 'published',
        error: null,
        published: {
          actionId: input.actionId,
          event: input.event,
          inline: submission.comments.length,
          inBody: kept.length - submission.comments.length,
          headMoved,
          at: this.now().toISOString(),
        },
      }),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    this.releaseRunListener();
    await this.running?.catch(() => undefined);
  }

  private recover(): void {
    for (const draft of this.store.draftsWithStatus([
      'queued',
      'running',
      'publishing',
    ]))
      this.replace(
        draft,
        draft.status === 'publishing'
          ? {
              status: 'ready',
              error:
                'Publishing was interrupted. Check the pull request on GitHub before publishing again.',
            }
          : {
              status: 'interrupted',
              error:
                'The host stopped before this review finished. Start a new review.',
            },
        false,
      );
  }

  private pump(): void {
    if (this.closed || this.running) return;
    const next = this.store.draftsWithStatus(['queued'])[0];
    if (!next) return;
    this.running = this.run(next).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async run(queued: ReviewDraft): Promise<void> {
    let draft = this.replace(queued, { status: 'running', error: null });
    try {
      const signal = this.controller.signal;
      const description =
        this.descriptions.get(draft.id) ??
        (await this.pullRequests.reviewTarget(draft.reference)).body;
      this.descriptions.delete(draft.id);
      const { profile } = draft;
      const session = await this.sessions.createWithEffort(
        {
          requestId: derivedId('review-session', draft.id),
          title: sessionTitle(draft.reference, draft.title),
          provider: profile.provider,
          model: profile.model,
          mode: 'read-only',
          directory: draft.directory,
          isolation: {
            kind: 'worktree',
            branch: `${AGENT_REVIEW_BRANCH_PREFIX}${draft.reference.number}-${draft.id.slice(0, 8)}`,
          },
          ...(profile.effort ? { effort: profile.effort } : {}),
        },
        signal,
      );
      draft = this.replace(draft, { sessionId: session.id });
      this.sessions.linkPullRequest({
        sessionId: session.id,
        pullRequest: draft.reference,
      });
      await this.whenFolderFree(session.directory, 'write');
      const files = await this.checkout(draft, session.id, signal);
      draft = this.replace(draft, { headSha: files.headSha });
      await this.whenFolderFree(session.directory, 'read');
      const started = this.sessions.send(
        {
          sessionId: session.id,
          messageId: derivedId('review-message', draft.id),
          text: reviewPrompt(draft, description, files, this.store.conventions()),
        },
        { outputSchema: agentReviewOutputJsonSchema(), instructionsOnly: true },
      );
      if (!started.runId)
        throw new CodeReviewError(
          'unavailable',
          'The review session did not start a turn.',
        );
      const outcome = await this.sessions.finished(session.id, started.runId);
      this.complete(draft.id, outcome);
    } catch (error) {
      const current = this.store.draft(draft.id);
      if (current?.status === 'running')
        this.replace(current, {
          status: 'failed',
          error: this.closed
            ? 'The host stopped before this review finished. Start a new review.'
            : failureMessage(error),
        });
    }
  }

  private async checkout(
    draft: ReviewDraft,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PullRequestFiles> {
    let commit = '';
    await this.sessions.withPullRequestCheckout(
      sessionId,
      async (session: Session) => {
        await this.pullRequests.checkoutDetached(
          draft.reference,
          session.directory,
          signal,
        );
        commit = await readHeadCommit(session.directory, signal);
      },
    );
    const files = await this.pullRequests.files(draft.reference);
    if (files.headSha !== commit)
      throw new CodeReviewError(
        'unavailable',
        'The pull request changed while the review was prepared. Start a new review.',
      );
    return files;
  }

  private complete(draftId: string, outcome: RunOutcome): void {
    const draft = this.store.draft(draftId);
    if (draft?.status !== 'running') return;
    if (outcome.state !== 'completed') {
      this.replace(draft, {
        status: 'failed',
        error: (
          outcome.error ??
          (outcome.state in OUTCOME_MESSAGES
            ? OUTCOME_MESSAGES[outcome.state as keyof typeof OUTCOME_MESSAGES]
            : 'The review session did not complete.')
        ).slice(0, codeReviewLimits.error),
      });
      return;
    }
    const parsed = parseAgentFindings(outcome.structured, draft.profile);
    if (!parsed.valid) {
      this.replace(draft, { status: 'invalid', error: parsed.error });
      return;
    }
    this.replace(draft, {
      status: 'ready',
      error: null,
      summary: parsed.summary,
      findings: parsed.findings,
      filtered: parsed.filtered,
    });
  }

  private async whenFolderFree(
    directory: string,
    access: 'read' | 'write',
  ): Promise<void> {
    const timeout = AbortSignal.timeout(FOLDER_WAIT_MS);
    try {
      await this.sessions.whenFolderFree(
        directory,
        access,
        AbortSignal.any([this.controller.signal, timeout]),
      );
    } catch (error) {
      if (this.closed)
        throw new CodeReviewError('unavailable', 'The host is shutting down.');
      if (timeout.aborted)
        throw new SessionError(
          'busy',
          'The review folder stayed in use, so the review could not start. Start it again.',
        );
      throw error;
    }
  }

  private current(draftId: string, expectedRevision: number): ReviewDraft {
    const draft = this.store.draft(draftId);
    if (!draft)
      throw new CodeReviewError('not-found', 'Draft review not found.');
    if (draft.revision !== expectedRevision)
      throw new CodeReviewError(
        'invalid-request',
        'This draft review changed. Refresh and try again.',
      );
    return draft;
  }

  private replace(
    draft: ReviewDraft,
    changes: Partial<ReviewDraft>,
    notify = true,
  ): ReviewDraft {
    const next: ReviewDraft = {
      ...draft,
      ...changes,
      revision: draft.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!this.store.replaceDraft(next, draft.revision))
      throw new CodeReviewError(
        'invalid-request',
        'This draft review changed. Refresh and try again.',
      );
    if (notify) this.announce(next);
    return next;
  }

  private announce(draft: ReviewDraft): void {
    this.emit({ type: 'pull-request-review-changed', draft });
  }
}
