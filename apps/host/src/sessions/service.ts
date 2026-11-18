import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  claudeModelSchema,
  delegationPlanSchema,
  isProviderSessionMode,
  isWritableSessionMode,
  sessionModeSchema,
  sessionQueueLimit,
  workerProposalSchema,
  type AssignSessionWorkflowInput,
  type LinkSessionPullRequestInput,
  type CreateSessionInput,
  type FinishSessionWorktreeInput,
  type ReadSessionWorktreeInput,
  type DecideDelegationInput,
  type DecideReviewInput,
  type DecideWorkerPlanInput,
  type Review,
  type ReviewDiff,
  type Delegation,
  type DesktopEvent,
  type QueuedMessageRefInput,
  type SendMessageInput,
  type Session,
  type StopRunInput,
  type RespondApprovalInput,
  type SkillReference,
  type SessionInterruption,
  type McpServerList,
  type SetSessionMcpInput,
  type TurnUsage,
} from '@nesvo/contracts';
import { readFingerprintKey } from '../mcp/fingerprint-key';
import {
  McpError,
  listMcpServers,
  prepareTurnMcp,
  resolveMcpSelection,
  type TurnMcp,
} from '../mcp/service';
import {
  reportedClaudeModes,
  startClaude,
  type ClaudeEvent,
  type ClaudeResult,
} from '../providers/claude';
import {
  inspectCodex,
  startCodex,
  type CodexEvent,
  type CodexResult,
} from '../providers/codex';
import { SessionStore, type SessionOrigin } from './store';
import { finishActivities, updateActivity } from './activities';
import { ReviewStore } from '../review/store';
import { resolveSessionSkill } from '../skills/service';
import {
  readSkillSnapshot,
  sharedSkillPrompt,
  skillCompatibility,
} from '../skills/portable';
import {
  captureWorkspace,
  compareWorkspace,
  type WorkspaceSnapshot,
} from '../review/workspace';
import { loadCatalog } from '../workflows/definitions';
import { resolveFolder } from '../workspace/folder';
import {
  createSessionWorktree,
  readSessionWorktreeStatus,
  removeSessionWorktree,
  worktreeSlug,
} from '../workspace/isolation';

export async function confirmCodexEffort(
  model: string,
  effort: string,
  signal: AbortSignal,
): Promise<void> {
  const status = await inspectCodex(signal);
  if (status.status !== 'ready')
    throw new SessionError(
      'unavailable',
      'Codex is not ready, so the reasoning effort could not be confirmed. Refresh Codex and try again.',
    );
  const efforts = status.models.find(item => item.id === model)?.efforts;
  if (!efforts?.options.some(option => option.id === effort))
    throw new SessionError(
      'invalid-request',
      `Codex does not report the ${effort} reasoning effort for ${model}.`,
    );
}

type TurnSelection = Pick<Session, 'model' | 'effort' | 'mode'>;

const WORKER_PLAN_LIMIT = 12_000;
const WORKER_PLAN_ROUND_LIMIT = 5;

const delegationToolInputSchema = delegationPlanSchema.safeExtend({
  workers: z
    .array(
      workerProposalSchema.safeExtend({
        mode: sessionModeSchema.extract(['read-only', 'supervised']),
      }),
    )
    .min(1)
    .max(2),
});

const delegationToolSchema = z.toJSONSchema(delegationToolInputSchema, {
  io: 'input',
});

const workerPrompt = (proposal: Delegation): string =>
  `You are a visible Nesvo worker. Complete only the assigned task within the stated scope. Scope is an assignment boundary, not a filesystem security sandbox. Do not delegate or start additional workers. Report concrete results and any limitations.\n\nScope:\n${proposal.scope}\n\nTask:\n${proposal.task}`;

const workerPlanPrompt = (proposal: Delegation, correction?: string): string =>
  `${workerPrompt(proposal)}\n\nFirst produce a plan only: list the files you would change and the steps, do not change anything yet.${correction ? `\n\nCorrection from the operator:\n${correction}` : ''}`;

const approvedPlanPrompt = (proposal: Delegation): string =>
  `${workerPrompt(proposal)}\n\nApproved plan:\n${proposal.plan ?? ''}`;

const isActiveDelegation = (proposal: Delegation): boolean =>
  proposal.status === 'running' || proposal.status === 'planning';

function resolveTurnMode(
  session: Session,
  mode: SendMessageInput['mode'],
): Session['mode'] {
  if (!mode || mode === session.mode) return session.mode;
  if (session.role === 'worker' || session.parentId)
    throw new SessionError(
      'invalid-request',
      'Worker permissions are set by the parent decision.',
    );
  if (session.workflowRunId)
    throw new SessionError(
      'invalid-request',
      'Workflow sessions keep the permissions chosen when the task started.',
    );
  if (!isProviderSessionMode(session.provider, mode))
    throw new SessionError(
      'invalid-request',
      `${session.provider} does not support the ${mode} permission mode.`,
    );
  if (
    session.provider === 'Claude Code' &&
    reportedClaudeModes()?.includes(mode) === false
  )
    throw new SessionError(
      'invalid-request',
      'This Claude Code version does not offer that permission mode. Update the CLI or choose Plan.',
    );
  return mode;
}

function resolveTurnSelection(
  session: Session,
  input: Pick<SendMessageInput, 'model' | 'effort' | 'mode'>,
): TurnSelection {
  const model = input.model ?? session.model;
  const effort = input.effort === undefined ? session.effort : input.effort;
  const mode = resolveTurnMode(session, input.mode);
  if (
    session.provider === 'Claude Code' &&
    !claudeModelSchema.safeParse(model).success
  )
    throw new SessionError(
      'invalid-request',
      'Unsupported Claude Code model. Choose default, opus, sonnet or haiku.',
    );
  if (effort && session.provider === 'Claude Code')
    throw new SessionError(
      'invalid-request',
      'Claude Code sessions do not accept a reasoning effort.',
    );
  if (effort && model === 'default')
    throw new SessionError(
      'invalid-request',
      'Choose a specific Codex model to set a reasoning effort.',
    );
  return { model, effort, mode };
}

function holdQueue(session: Session): void {
  session.queue = session.queue.map(item => ({ ...item, held: true }));
}

export class SessionError extends Error {
  constructor(
    readonly code:
      | 'busy'
      | 'not-found'
      | 'invalid-directory'
      | 'invalid-request'
      | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export class BudgetRefusal extends SessionError {
  constructor(message: string) {
    super('invalid-request', message);
  }
}

type ActiveRun = {
  session: Session;
  handle: ReturnType<typeof startClaude> | ReturnType<typeof startCodex>;
  finished: Promise<void>;
  evictedActivities: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
  persistenceError?: boolean;
  finalizing?: boolean;
};

export type RunFinished = {
  sessionId: string;
  runId: string;
  workflowRunId: string | null;
  status: Session['status'];
  reviewId: string | null;
};

export type WorkflowTurnState =
  'none' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export type WorkflowTurn = {
  sessionId: string;
  messageId: string;
  text: string;
  readOnly?: boolean;
  skillId?: string;
  skillHash?: string;
  outputSchema?: Record<string, unknown>;
  ephemeral?: boolean;
  instructionsOnly?: boolean;
  assistant?: boolean;
  assistantPrompt?: string;
};

export type SessionServiceOptions = {
  checkCostBudgets?: (
    session: Session,
    now: Date,
  ) => {
    warning?: string;
    refusal?: string;
  };
  environment?: (
    session: Session,
  ) => Readonly<Record<string, string>> | undefined;
  isHeldByWorkflow?: (review: Review) => boolean;
  isKnownGroup?: (groupId: string) => boolean;
};

export const GATE_PENDING_MESSAGE =
  'This result is waiting for its workflow gate';

export type GateReviewDecision = {
  reviewId: string;
  version: number;
  decisionId: string;
  decision: 'accept' | 'reject' | 'request-changes';
  feedback: string;
};

const GATE_REVIEW_STATUS = {
  accept: 'accepted',
  reject: 'rejected',
  'request-changes': 'changes-requested',
} as const satisfies Record<GateReviewDecision['decision'], Review['status']>;

type LaunchTurn = {
  skillId?: string;
  skillHash?: string;
  readOnly?: boolean;
  outputSchema?: Record<string, unknown>;
  ephemeral?: boolean;
  instructionsOnly?: boolean;
  assistantPrompt?: string;
  previousSelection?: TurnSelection;
};

export type RunOutcome = {
  state: Session['status'];
  error: string | null;
  interruption: SessionInterruption['reason'] | null;
  reviewId: string | null;
  limit: { resetsAt: string | null } | null;
  usage: TurnUsage | null;
  structured: unknown;
};

const MAX_REMEMBERED_LIMITS = 100;
const STREAM_PERSIST_INTERVAL = 1000;

type WorkerResult = {
  delegationId: string;
  childSessionId: string | null;
  status: Delegation['status'];
  text: string;
  error: string | null;
};

export class SessionService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly waiters = new Map<string, (result: WorkerResult) => void>();
  private readonly unsaved = new Map<string, Session>();
  private readonly limits = new Map<string, { resetsAt: string | null }>();
  private readonly structuredOutputs = new Map<string, unknown>();
  private readonly planRuns = new Set<string>();
  private readonly finishedListeners = new Set<(run: RunFinished) => void>();
  private closing = false;
  private mcpKey?: Buffer;
  private checkingOut = false;
  private removingWorktree = false;
  private reviewDecision?: AbortController;
  private lastOperatorActivityAt?: number;

  constructor(
    private readonly store: SessionStore,
    private readonly directory: string,
    private readonly emit: (event: DesktopEvent) => void,
    private readonly reviews: ReviewStore,
    recoverRelated?: () => void,
    private readonly options: SessionServiceOptions = {},
  ) {
    store.recover(recoverRelated);
  }

  onRunFinished(listener: (run: RunFinished) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  turnState(sessionId: string, messageId: string): WorkflowTurnState {
    const active = this.active.get(sessionId);
    const session =
      active?.session ??
      this.unsaved.get(sessionId) ??
      this.store.get(sessionId);
    const request = session?.messages.find(
      message =>
        message.id === messageId &&
        message.author === 'operator' &&
        message.origin === 'workflow',
    );
    if (!session || !request) return 'none';
    if (active?.session.runId === request.runId) return 'running';
    const reply = session.messages.find(
      message => message.runId === request.runId && message.author === 'agent',
    );
    if (
      reply?.state === 'completed' ||
      reply?.state === 'failed' ||
      reply?.state === 'stopped' ||
      reply?.state === 'interrupted'
    )
      return reply.state;
    return reply ? 'running' : 'failed';
  }

  turnReply(sessionId: string, messageId: string): string | null {
    const session =
      this.active.get(sessionId)?.session ?? this.store.get(sessionId);
    const request = session?.messages.find(
      message => message.id === messageId && message.author === 'operator',
    );
    const reply = session?.messages.find(
      message =>
        message.runId === request?.runId &&
        message.author === 'agent' &&
        message.state === 'completed',
    );
    return reply?.body ?? null;
  }

  sendWorkflowTurn(turn: WorkflowTurn): 'sent' | 'busy' {
    const session =
      this.active.get(turn.sessionId)?.session ??
      this.store.get(turn.sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    if (
      !session.workflowRunId &&
      !(turn.assistant && session.mode === 'read-only' && !session.parentId)
    )
      throw new SessionError(
        'invalid-request',
        'This session is not part of a workflow task.',
      );
    const existing = session.messages.find(
      message => message.id === turn.messageId,
    );
    if (existing) {
      if (existing.author !== 'operator' || existing.origin !== 'workflow')
        throw new SessionError(
          'invalid-request',
          'This message ID is already in use.',
        );
      return 'sent';
    }
    if (!this.canStartWorkflowTurn()) return 'busy';
    this.resolveDirectory(session.directory);
    this.ensureConversationCapacity(session);
    const prompt = this.recoveryPrompt(session, turn.text);
    const ephemeral =
      turn.ephemeral === true && session.provider === 'Claude Code';
    this.prepareRun(
      session,
      turn.messageId,
      turn.text,
      turn.skillId,
      turn.skillHash,
      'workflow',
    );
    if (ephemeral) session.providerSessionId = randomUUID();
    const superseded = this.reviews.supersededBy(session.id);
    this.store.saveMany([session], () => this.reviews.saveMany(superseded));
    this.emitSession(session);
    this.emitReviews(superseded);
    this.launch(session, prompt, {
      readOnly: turn.readOnly,
      skillId: turn.skillId,
      skillHash: turn.skillHash,
      outputSchema: turn.outputSchema,
      ephemeral,
      instructionsOnly: turn.instructionsOnly,
      assistantPrompt: turn.assistant ? turn.assistantPrompt : undefined,
    });
    return 'sent';
  }

  latestReview(sessionId: string): Review | undefined {
    return this.reviews.latest(sessionId);
  }

  continueWithFeedback(
    sessionId: string,
    text: string,
    messageId: string,
  ): 'sent' | 'busy' {
    return this.sendWorkflowTurn({ sessionId, messageId, text });
  }

  isWorkflowTurnActive(sessionId: string, runId: string): boolean {
    const active = this.active.get(sessionId);
    return (
      !!active &&
      !active.finalizing &&
      active.session.runId === runId &&
      active.session.messages.some(
        message =>
          message.runId === runId &&
          message.author === 'operator' &&
          message.origin === 'workflow',
      )
    );
  }

  stopActive(sessionId: string, reason?: SessionInterruption['reason']): void {
    const active = this.active.get(sessionId);
    if (active?.session.runId)
      this.stop({ sessionId, runId: active.session.runId }, reason);
  }

  canStartWorkflowTurn(): boolean {
    return !this.isBusy() && !this.unsaved.size;
  }

  isBusy(): boolean {
    return (
      this.closing ||
      this.checkingOut ||
      this.removingWorktree ||
      this.active.size > 0 ||
      !!this.reviewDecision
    );
  }

  recordOperatorActivity(at = new Date()): void {
    this.lastOperatorActivityAt = at.getTime();
  }

  isIdleFor(milliseconds: number, now = new Date()): boolean {
    return (
      !this.lastOperatorActivityAt ||
      now.getTime() - this.lastOperatorActivityAt >= milliseconds
    );
  }

  listReviews(): Review[] {
    return this.reviews.list();
  }

  async decideReview(input: DecideReviewInput): Promise<Review> {
    const recorded = this.reviews.byDecision(input.decisionId);
    if (recorded) {
      if (
        recorded.id !== input.reviewId ||
        recorded.version !== input.version ||
        recorded.decision?.decision !== input.decision ||
        recorded.decision.feedback !== input.feedback
      )
        throw new SessionError(
          'invalid-request',
          'This decision ID is already in use.',
        );
      return recorded;
    }
    const requested = this.reviews.get(input.reviewId);
    if (requested) this.ensureNotHeldByWorkflow(requested);
    this.ensureReviewIdle();
    const { review, session } = this.currentReview(
      input.reviewId,
      input.version,
      ['pending'],
    );
    const controller = new AbortController();
    this.reviewDecision = controller;
    try {
      if (input.decision === 'accept')
        await this.verifyFiles(review, controller.signal);
      this.ensureDecisionOpen(controller);
      this.ensureNotHeldByWorkflow(review);
      const decided = this.reviews.change(review, {
        status: input.decision === 'accept' ? 'accepted' : 'changes-requested',
        decision: {
          id: input.decisionId,
          decision: input.decision,
          feedback: input.feedback,
          at: new Date().toISOString(),
        },
      });
      if (input.decision === 'request-changes') {
        this.resolveDirectory(session.directory);
        this.ensureConversationCapacity(session);
        if (session.messages.some(message => message.id === input.decisionId))
          throw new SessionError(
            'invalid-request',
            'This decision ID is already used by a message.',
          );
        const text = `Correction to version ${review.version}:\n${input.feedback}`;
        const prompt = `Revise your previous result using the operator feedback below. Keep the same permissions and assigned scope. Do not delegate additional work unless this session already has a delegation tool.\n\nOriginal task:\n${review.task}\n\nScope:\n${session.scope ?? session.directory}\n\nOperator feedback:\n${input.feedback}`;
        this.prepareRun(session, input.decisionId, text);
        const changed = [
          ...this.reviews
            .supersededBy(session.id)
            .filter(item => item.id !== review.id),
          decided,
        ];
        this.store.saveMany([session], () => this.reviews.saveMany(changed));
        this.emitSession(session);
        this.emitReviews(changed);
        this.launch(session, prompt, {});
      } else {
        this.store.saveMany([], () => this.reviews.saveMany([decided]));
        this.emitReviews([decided]);
      }
      return decided;
    } finally {
      if (this.reviewDecision === controller) this.reviewDecision = undefined;
    }
  }

  async decideGateReview(
    input: GateReviewDecision,
    record: () => void,
  ): Promise<Review> {
    this.ensureReviewIdle();
    const { review } = this.currentReview(
      input.reviewId,
      input.version,
      input.decision === 'accept' ? ['pending', 'accepted'] : ['pending'],
    );
    const controller = new AbortController();
    this.reviewDecision = controller;
    try {
      if (input.decision === 'accept')
        await this.verifyFiles(review, controller.signal);
      this.ensureDecisionOpen(controller);
      const decided =
        review.status === 'pending'
          ? this.reviews.change(review, {
              status: GATE_REVIEW_STATUS[input.decision],
              decision: {
                id: input.decisionId,
                decision: input.decision,
                feedback: input.feedback,
                at: new Date().toISOString(),
              },
            })
          : null;
      this.store.saveMany([], () => {
        if (decided) this.reviews.saveMany([decided]);
        record();
      });
      if (decided) this.emitReviews([decided]);
      return decided ?? review;
    } finally {
      if (this.reviewDecision === controller) this.reviewDecision = undefined;
    }
  }

  private ensureNotHeldByWorkflow(review: Review): void {
    if (this.options.isHeldByWorkflow?.(review))
      throw new SessionError('busy', GATE_PENDING_MESSAGE);
  }

  private ensureReviewIdle(): void {
    if (this.isBusy() || this.unsaved.size)
      throw new SessionError(
        'busy',
        'Wait for the active group to finish and its result to be saved.',
      );
  }

  private ensureDecisionOpen(controller: AbortController): void {
    if (this.closing || controller.signal.aborted)
      throw new SessionError(
        'busy',
        'The host is closing. Your decision was not saved.',
      );
  }

  private currentReview(
    reviewId: string,
    version: number,
    statuses: readonly Review['status'][],
  ): { review: Review; session: Session } {
    const review = this.reviews.get(reviewId);
    const session = review ? this.store.get(review.sessionId) : undefined;
    if (
      !review ||
      !session ||
      !statuses.includes(review.status) ||
      review.version !== version ||
      session.runId !== review.runId ||
      session.status !== 'completed' ||
      this.reviews.latest(session.id)?.id !== review.id
    )
      throw new SessionError(
        'invalid-request',
        'This result is no longer current or has already been reviewed. Refresh the inbox.',
      );
    for (const dependency of review.dependencies) {
      const current = this.reviews.latest(dependency.sessionId);
      const child = this.store.get(dependency.sessionId);
      if (
        current?.id !== dependency.reviewId ||
        current.version !== dependency.version ||
        current.status === 'superseded' ||
        child?.runId !== current.runId ||
        child.status !== 'completed'
      )
        throw new SessionError(
          'invalid-request',
          'A worker result has changed. Ask the parent session for an updated summary.',
        );
    }
    return { review, session };
  }

  private async verifyFiles(
    review: Review,
    signal: AbortSignal,
  ): Promise<void> {
    const artifacts = [
      review,
      ...review.dependencies.map(dependency =>
        this.reviews.get(dependency.reviewId)!,
      ),
    ];
    for (const artifact of artifacts) {
      if (artifact.diff.status === 'not-applicable') continue;
      if (artifact.diff.status !== 'complete' || !artifact.diff.fingerprint)
        throw new SessionError(
          'invalid-request',
          'The result or its worker has no complete diff. Request changes to the affected result with a smaller scope.',
        );
      const current = await captureWorkspace(artifact.directory, signal);
      if (
        current.status !== 'complete' ||
        current.fingerprint !== artifact.diff.fingerprint
      )
        throw new SessionError(
          'invalid-request',
          'Files for this result or its worker have changed since capture or cannot be checked. Revise the affected session and review its current result.',
        );
    }
  }

  private ensureConversationCapacity(session: Session): void {
    if (JSON.stringify(session).length > 4_000_000)
      throw new SessionError(
        'invalid-request',
        'This conversation has reached the prototype limit. Create a new session.',
      );
  }

  private emitReviews(reviews: Review[]): void {
    for (const review of reviews)
      this.emit({ type: 'review-changed', review: structuredClone(review) });
  }

  list(): Session[] {
    for (const [id, session] of this.unsaved) {
      try {
        this.publish(session);
        this.unsaved.delete(id);
      } catch {
        continue;
      }
    }
    const sessions = this.store.list().map(session => {
      const active = this.active.get(session.id);
      return active && !active.finalizing
        ? structuredClone(active.session)
        : session;
    });
    sessions.sort(
      (first, second) =>
        second.updatedAt.localeCompare(first.updatedAt) ||
        first.id.localeCompare(second.id),
    );
    return [
      ...[...this.unsaved.values()].map(session => structuredClone(session)),
      ...sessions.filter(session => !this.unsaved.has(session.id)),
    ];
  }

  adoptConversation(
    input: CreateSessionInput,
    directory: string,
    origin: Extract<SessionOrigin, { kind: 'import' }>,
  ): Session {
    if (this.closing)
      throw new SessionError('unavailable', 'The host is shutting down.');
    const session = this.store.create(input, directory, origin);
    this.emitSession(session);
    return session;
  }

  create(
    input: CreateSessionInput,
    options: {
      isolatedDirectory?: string;
      origin?: SessionOrigin;
      mcp?: Session['mcp'];
      worktree?: { id: string; metadata: NonNullable<Session['worktree']> };
    } = {},
  ): Session {
    if (input.isolation && !options.worktree)
      throw new SessionError(
        'invalid-request',
        'Prepare the session worktree before creating the session.',
      );
    if (input.groupId && !this.options.isKnownGroup?.(input.groupId))
      throw new SessionError(
        'invalid-request',
        'The session group no longer exists. Refresh the sidebar and try again.',
      );
    if (!options.mcp && (input.mcp?.servers.length || input.mcp?.hooks))
      throw new SessionError(
        'invalid-request',
        'MCP servers and hooks must be confirmed by the host before the session is created.',
      );
    let directory = options.isolatedDirectory ?? input.directory;
    if (!directory) {
      directory = join(this.directory, 'workspaces', randomUUID());
      mkdirSync(directory, { recursive: true });
    }
    directory = this.resolveDirectory(directory);
    const session = this.store.create(
      input,
      directory,
      options.origin,
      options.mcp,
      options.worktree,
    );
    this.emitSession(session);
    return session;
  }

  async finished(sessionId: string, runId: string): Promise<RunOutcome> {
    const active = this.active.get(sessionId);
    if (active?.session.runId === runId) await active.finished;
    const session = this.unsaved.get(sessionId) ?? this.store.get(sessionId);
    const message = session?.messages.find(
      item => item.runId === runId && item.author === 'agent',
    );
    if (!message)
      throw new SessionError('not-found', 'This run is not in the session.');
    const review = this.reviews.latest(sessionId);
    const structured =
      message.state === 'completed'
        ? this.structuredOutputs.get(runId)
        : undefined;
    this.structuredOutputs.delete(runId);
    return {
      state: message.state,
      error: session?.error ?? null,
      interruption: message.interruption?.reason ?? null,
      reviewId:
        message.state === 'completed' && review?.runId === runId
          ? review.id
          : null,
      limit:
        message.state === 'failed' ? (this.limits.get(runId) ?? null) : null,
      usage: message.usage,
      structured,
    };
  }

  private rememberLimit(
    runId: string,
    limit: { resetsAt: string | null },
  ): void {
    this.limits.set(runId, limit);
    if (this.limits.size > MAX_REMEMBERED_LIMITS)
      this.limits.delete(this.limits.keys().next().value!);
  }

  private rememberStructured(runId: string, value: unknown): void {
    this.structuredOutputs.set(runId, value);
    if (this.structuredOutputs.size > MAX_REMEMBERED_LIMITS)
      this.structuredOutputs.delete(
        this.structuredOutputs.keys().next().value!,
      );
  }

  async createWithEffort(
    input: CreateSessionInput,
    signal: AbortSignal,
  ): Promise<Session> {
    if (input.effort)
      await confirmCodexEffort(input.model, input.effort, signal);
    const mcp = input.mcp
      ? await this.confirmMcp(
          input.provider,
          this.draftDirectory(input.directory),
          input.mcp,
          signal,
        )
      : undefined;
    if (!input.isolation) return this.create(input, mcp ? { mcp } : {});
    const project = await resolveFolder(input.directory, signal);
    const id = randomUUID();
    const { worktree, branch, base, projectDirectory } =
      await createSessionWorktree({
        projectDirectory: project,
        dataDirectory: this.directory,
        slug: worktreeSlug(input.title, 'session'),
        runId: id,
        branch: input.isolation.branch,
        signal,
      });
    try {
      if (this.closing)
        throw new SessionError('busy', 'The host is shutting down.');
      return this.create(input, {
        mcp,
        isolatedDirectory: worktree,
        worktree: {
          id,
          metadata: { projectDirectory, branch, base, state: 'active' },
        },
      });
    } catch (error) {
      try {
        await removeSessionWorktree({
          projectDirectory,
          dataDirectory: this.directory,
          worktree,
          signal,
        });
      } catch {
        throw new SessionError(
          'unavailable',
          `The session could not be saved. The worktree at ${worktree} and branch ${branch} were retained.`,
        );
      }
      throw error;
    }
  }

  private sessionWorktree(sessionId: string) {
    const session =
      this.active.get(sessionId)?.session ?? this.store.get(sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    if (!session.worktree)
      throw new SessionError(
        'invalid-request',
        'This session has no managed worktree.',
      );
    return {
      session,
      metadata: session.worktree,
      location: {
        projectDirectory: session.worktree.projectDirectory,
        dataDirectory: this.directory,
        worktree: session.directory,
      },
    };
  }

  async readWorktree(input: ReadSessionWorktreeInput, signal: AbortSignal) {
    const { metadata, location } = this.sessionWorktree(input.sessionId);
    return metadata.state === 'removed'
      ? { dirty: false }
      : readSessionWorktreeStatus({ ...location, signal });
  }

  async finishWorktree(
    input: FinishSessionWorktreeInput,
    signal: AbortSignal,
  ): Promise<Session> {
    const { session, metadata, location } = this.sessionWorktree(
      input.sessionId,
    );
    if (this.isBusy() || this.unsaved.size)
      throw new SessionError(
        'busy',
        'Wait for active work on this computer to finish before finishing a worktree.',
      );
    if (metadata.state === 'removed') return session;
    if (input.action.kind !== 'remove') {
      if (metadata.state === 'active')
        this.markWorktreeFinished(session, 'kept');
      return session;
    }
    this.removingWorktree = true;
    try {
      await removeSessionWorktree({
        ...location,
        force: input.action.force,
        signal,
      });
      const current = this.sessionWorktree(session.id).session;
      this.markWorktreeFinished(current, 'removed');
      return current;
    } finally {
      this.removingWorktree = false;
    }
  }

  private markWorktreeFinished(
    session: Session,
    state: 'kept' | 'removed',
  ): void {
    session.worktree = { ...session.worktree!, state };
    holdQueue(session);
    this.publish(session);
  }

  private ensureWorktreeOpen(session: Session): void {
    const worktree =
      session.worktree ??
      (session.parentId
        ? this.store.get(session.parentId)?.worktree
        : undefined);
    if (worktree && worktree.state !== 'active')
      throw new SessionError(
        'invalid-request',
        'This worktree session is finished.',
      );
  }

  async setMcp(
    input: SetSessionMcpInput,
    signal: AbortSignal,
  ): Promise<Session> {
    const session = this.acceptingSession(input.sessionId);
    if (session.role === 'worker')
      throw new SessionError(
        'invalid-request',
        'Workers follow the tools their parent approved and cannot change MCP servers or hooks.',
      );
    if (session.workflowRunId)
      throw new SessionError(
        'invalid-request',
        'A workflow session keeps the tools its task started with.',
      );
    const mcp = await this.confirmMcp(
      session.provider,
      this.resolveDirectory(session.directory),
      input,
      signal,
    );
    const current = this.acceptingSession(input.sessionId);
    const previous = current.mcp;
    current.mcp = mcp;
    try {
      this.publish(current);
    } catch (error) {
      current.mcp = previous;
      throw error;
    }
    return structuredClone(current);
  }

  async mcpServers(
    provider: Session['provider'],
    directory: string,
    signal: AbortSignal,
  ): Promise<McpServerList> {
    return listMcpServers(this.fingerprintKey(), provider, directory, signal);
  }

  private fingerprintKey(): Buffer {
    this.mcpKey ??= readFingerprintKey(this.directory);
    return this.mcpKey;
  }

  private async confirmMcp(
    provider: Session['provider'],
    directory: string,
    selection: { servers: string[]; hooks: boolean },
    signal: AbortSignal,
  ): Promise<Session['mcp']> {
    try {
      return await resolveMcpSelection(
        this.fingerprintKey(),
        provider,
        directory,
        { servers: selection.servers, hooks: selection.hooks },
        signal,
      );
    } catch (error) {
      if (error instanceof McpError)
        throw new SessionError('invalid-request', error.message);
      throw new SessionError(
        'unavailable',
        'The MCP configuration could not be read. Try again.',
      );
    }
  }

  draftDirectory(directory: string): string {
    if (directory) return this.resolveDirectory(directory);
    const workspaces = join(this.directory, 'workspaces');
    mkdirSync(workspaces, { recursive: true });
    return this.resolveDirectory(workspaces);
  }

  send(input: SendMessageInput): Session {
    if (this.unsaved.size) {
      this.list();
      if (this.unsaved.size)
        throw new SessionError(
          'busy',
          'The last response was not saved. Refresh history after database access is restored.',
        );
    }
    const session =
      this.active.get(input.sessionId)?.session ??
      this.store.get(input.sessionId);
    if (!session)
      throw new SessionError(
        'not-found',
        'Session not found. Refresh the list.',
      );
    if (session.workflowStepId)
      throw new SessionError(
        'invalid-request',
        'This session records a workflow gate and does not accept messages. Start a new session to continue the work.',
      );
    const existing = session.messages.find(
      message => message.id === input.messageId,
    );
    if (existing) {
      if (
        existing.author !== 'operator' ||
        existing.body !== input.text ||
        existing.skillId !== input.skillId ||
        existing.skillHash !== input.skillHash
      )
        throw new SessionError(
          'invalid-request',
          'This message ID is already in use.',
        );
      return structuredClone(session);
    }
    this.ensureWorktreeOpen(session);
    if (this.isBusy())
      throw new SessionError(
        'busy',
        'Wait for the active group to finish or use Stop.',
      );
    if (input.skillHash && !input.skillId)
      throw new SessionError(
        'invalid-request',
        'A skill snapshot requires a selected skill.',
      );
    const selection = resolveTurnSelection(session, input);
    this.resolveDirectory(session.directory);
    this.ensureConversationCapacity(session);
    const prompt = this.recoveryPrompt(session, input.text);
    const previousSelection = {
      model: session.model,
      effort: session.effort,
      mode: session.mode,
    };
    session.model = selection.model;
    session.effort = selection.effort;
    session.mode = selection.mode;
    this.prepareRun(
      session,
      input.messageId,
      input.text,
      input.skillId,
      input.skillHash,
    );
    session.queue = session.queue.filter(item => item.id !== input.messageId);
    const superseded = this.reviews.supersededBy(session.id);
    this.store.saveMany([session], () => this.reviews.saveMany(superseded));
    this.emitSession(session);
    this.emitReviews(superseded);
    this.launch(session, prompt, {
      skillId: input.skillId,
      skillHash: input.skillHash,
      previousSelection,
    });
    return structuredClone(session);
  }

  linkPullRequest(input: LinkSessionPullRequestInput): Session {
    const session =
      this.active.get(input.sessionId)?.session ??
      this.unsaved.get(input.sessionId) ??
      this.store.get(input.sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    const previous = session.pullRequest;
    if (
      previous?.repository === input.pullRequest?.repository &&
      previous?.number === input.pullRequest?.number
    )
      return structuredClone(session);
    session.pullRequest = input.pullRequest;
    try {
      this.publish(session);
    } catch (error) {
      session.pullRequest = previous;
      throw error;
    }
    return structuredClone(session);
  }

  isRunning(sessionId: string): boolean {
    const session =
      this.active.get(sessionId)?.session ?? this.store.get(sessionId);
    return (
      this.active.has(sessionId) ||
      session?.status === 'running' ||
      session?.status === 'stopping'
    );
  }

  amend(
    sessionIds: string[],
    change: (sessions: Session[]) => void,
    writeRelated?: () => void,
  ): Session[] {
    const targets = [...new Set(sessionIds)].map(id => {
      const session =
        this.active.get(id)?.session ??
        this.unsaved.get(id) ??
        this.store.get(id);
      if (!session) throw new SessionError('not-found', 'Session not found.');
      return session;
    });
    const previous = targets.map(
      ({ title, groupId, order, pinned, archivedAt }) => ({
        title,
        groupId,
        order,
        pinned,
        archivedAt,
      }),
    );
    try {
      change(targets);
      this.store.saveMany(targets, writeRelated, { touch: false });
    } catch (error) {
      targets.forEach((session, index) =>
        Object.assign(session, previous[index]),
      );
      throw error;
    }
    for (const session of targets) this.emitSession(session);
    return targets.map(session => structuredClone(session));
  }

  async withPullRequestCheckout(
    sessionId: string,
    run: (session: Session) => Promise<void>,
  ): Promise<void> {
    const session =
      this.active.get(sessionId)?.session ?? this.store.get(sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    this.ensureWorktreeOpen(session);
    if (
      session.status === 'running' ||
      session.status === 'stopping' ||
      this.active.has(sessionId)
    )
      throw new SessionError(
        'busy',
        'Stop the session before checking out a pull request.',
      );
    if (this.isBusy())
      throw new SessionError(
        'busy',
        'Wait for the active workspace operation to finish before checking out a pull request.',
      );
    this.checkingOut = true;
    try {
      await run(session);
    } finally {
      this.checkingOut = false;
    }
  }

  async assignWorkflow(
    input: AssignSessionWorkflowInput,
    signal: AbortSignal,
  ): Promise<Session> {
    const session = this.acceptingSession(input.sessionId);
    if (session.role === 'worker')
      throw new SessionError(
        'invalid-request',
        'Workers follow the task from their parent and cannot carry a workflow.',
      );
    if (session.workflowRunId)
      throw new SessionError(
        'invalid-request',
        'This session already belongs to a workflow task.',
      );
    if (input.workflow) {
      const { name, root } = input.workflow;
      let available = false;
      try {
        const catalog = await loadCatalog(
          this.resolveDirectory(session.directory),
          signal,
        );
        available = catalog.workflows.some(
          workflow => workflow.name === name && workflow.source.scope === root,
        );
      } catch (error) {
        if (error instanceof SessionError) throw error;
      }
      if (!available)
        throw new SessionError(
          'invalid-request',
          'This workflow is not available for the session folder.',
        );
    }
    const current = this.acceptingSession(input.sessionId);
    const previous = current.workflow;
    current.workflow = input.workflow ? { ...input.workflow } : null;
    try {
      this.publish(current);
    } catch (error) {
      current.workflow = previous;
      throw error;
    }
    return structuredClone(current);
  }

  queue(input: SendMessageInput): Session {
    const session = this.acceptingSession(input.sessionId);
    this.ensureWorktreeOpen(session);
    if (input.skillHash && !input.skillId)
      throw new SessionError(
        'invalid-request',
        'A skill snapshot requires a selected skill.',
      );
    resolveTurnSelection(session, input);
    if (
      session.queue.some(item => item.id === input.messageId) ||
      session.messages.some(message => message.id === input.messageId)
    )
      return structuredClone(session);
    if (!this.isBusy()) return this.send(input);
    if (session.queue.length >= sessionQueueLimit)
      throw new SessionError(
        'invalid-request',
        'The queue is full. Remove a queued message first.',
      );
    session.queue.push({
      id: input.messageId,
      text: input.text,
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.skillHash ? { skillHash: input.skillHash } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.mode ? { mode: input.mode } : {}),
      createdAt: new Date().toISOString(),
      held: false,
    });
    try {
      this.publish(session);
    } catch (error) {
      session.queue.pop();
      throw error;
    }
    return structuredClone(session);
  }

  cancelQueued(input: QueuedMessageRefInput): Session {
    const session = this.acceptingSession(input.sessionId);
    const queue = session.queue;
    if (!queue.some(item => item.id === input.messageId)) {
      if (session.messages.some(message => message.id === input.messageId))
        throw new SessionError('not-found', 'This message already started.');
      return structuredClone(session);
    }
    session.queue = queue.filter(item => item.id !== input.messageId);
    try {
      this.publish(session);
    } catch (error) {
      session.queue = queue;
      throw error;
    }
    return structuredClone(session);
  }

  startQueued(input: QueuedMessageRefInput): Session {
    const session = this.acceptingSession(input.sessionId);
    const entry = session.queue.find(item => item.id === input.messageId);
    if (!entry)
      throw new SessionError(
        'not-found',
        'This queued message is no longer waiting. Refresh the session.',
      );
    if (this.isBusy())
      throw new SessionError(
        'busy',
        'Wait for the active run to finish or use Stop.',
      );
    return this.send({
      sessionId: session.id,
      messageId: entry.id,
      text: entry.text,
      skillId: entry.skillId,
      skillHash: entry.skillHash,
      model: entry.model,
      effort: entry.effort,
      mode: entry.mode,
    });
  }

  private acceptingSession(sessionId: string): Session {
    const session =
      this.active.get(sessionId)?.session ??
      this.unsaved.get(sessionId) ??
      this.store.get(sessionId);
    if (!session)
      throw new SessionError(
        'not-found',
        'Session not found. Refresh the list.',
      );
    if (session.workflowStepId)
      throw new SessionError(
        'invalid-request',
        'This session records a workflow gate and does not accept messages. Start a new session to continue the work.',
      );
    return session;
  }

  private startNextQueued(session: Session): void {
    const next = session.queue[0];
    if (session.status !== 'completed' || !next || next.held || this.isBusy())
      return;
    try {
      this.send({
        sessionId: session.id,
        messageId: next.id,
        text: next.text,
        skillId: next.skillId,
        skillHash: next.skillHash,
        model: next.model,
        effort: next.effort,
        mode: next.mode,
      });
    } catch (error) {
      if (error instanceof BudgetRefusal) holdQueue(session);
      session.error =
        error instanceof SessionError
          ? error.message
          : 'The next queued message could not start. Use Send now to retry.';
      try {
        this.publish(session);
      } catch {
        return;
      }
    }
  }

  decideDelegation(input: DecideDelegationInput): Session {
    const active = this.active.get(input.sessionId);
    const parent = active?.session;
    const proposal = parent?.delegations.find(
      item => item.id === input.delegationId,
    );
    if (
      !active ||
      !parent ||
      active.finalizing ||
      parent.runId !== input.runId ||
      parent.status !== 'running' ||
      proposal?.runId !== input.runId ||
      proposal.status !== 'pending' ||
      !this.waiters.has(proposal.id)
    )
      throw new SessionError(
        'invalid-request',
        'This worker proposal is no longer active.',
      );
    if (input.decision === 'decline') {
      proposal.status = 'declined';
      try {
        this.publish(parent);
      } catch (error) {
        proposal.status = 'pending';
        throw error;
      }
      this.settle(proposal);
      return structuredClone(parent);
    }
    const directory = this.workerDirectory(parent, proposal.directory);
    this.validateWorkerDirectories(
      parent,
      parent.delegations.filter(item => item.runId === input.runId),
    );
    const child = this.store.worker(parent, proposal, directory);
    const prompt = proposal.planFirst
      ? workerPlanPrompt(proposal)
      : workerPrompt(proposal);
    this.prepareRun(child, randomUUID(), proposal.task);
    proposal.childSessionId = child.id;
    proposal.childRunId = child.runId;
    proposal.status = proposal.planFirst ? 'planning' : 'running';
    try {
      this.store.saveMany([parent, child]);
    } catch (error) {
      proposal.childSessionId = null;
      proposal.childRunId = null;
      proposal.status = 'pending';
      throw error;
    }
    this.emitSession(parent);
    this.emitSession(child);
    if (proposal.planFirst) this.planRuns.add(child.runId!);
    this.launch(child, prompt, proposal.planFirst ? { readOnly: true } : {});
    return structuredClone(parent);
  }

  decideWorkerPlan(input: DecideWorkerPlanInput): Session {
    const active = this.active.get(input.sessionId);
    const parent = active?.session;
    const proposal = parent?.delegations.find(
      item => item.id === input.delegationId,
    );
    const child = proposal?.childSessionId
      ? this.store.get(proposal.childSessionId)
      : undefined;
    if (
      !active ||
      !parent ||
      active.finalizing ||
      parent.runId !== input.runId ||
      parent.status !== 'running' ||
      proposal?.runId !== input.runId ||
      proposal.status !== 'plan-ready' ||
      !this.waiters.has(proposal.id) ||
      !child ||
      child.parentId !== parent.id ||
      child.parentRunId !== parent.runId ||
      this.active.has(child.id) ||
      this.unsaved.has(child.id)
    )
      throw new SessionError(
        'invalid-request',
        'This worker plan is no longer waiting for a decision.',
      );
    if (input.decision === 'decline') {
      proposal.status = 'declined';
      try {
        this.publish(parent);
      } catch (error) {
        proposal.status = 'plan-ready';
        throw error;
      }
      this.settle(proposal);
      return structuredClone(parent);
    }
    if (input.decision === 'correct' && !input.correction)
      throw new SessionError(
        'invalid-request',
        'A correction is required to revise the plan.',
      );
    if (
      input.decision === 'correct' &&
      proposal.planRound > WORKER_PLAN_ROUND_LIMIT
    )
      throw new SessionError(
        'invalid-request',
        'This worker already revised its plan five times. Accept or decline it.',
      );
    const correcting = input.decision === 'correct';
    const prompt = correcting
      ? workerPlanPrompt(proposal, input.correction)
      : approvedPlanPrompt(proposal);
    const previous = {
      childRunId: proposal.childRunId,
      status: proposal.status,
      activity: parent.activity,
    };
    this.prepareRun(
      child,
      randomUUID(),
      correcting ? input.correction! : proposal.task,
    );
    proposal.childRunId = child.runId;
    proposal.status = correcting ? 'planning' : 'running';
    parent.activity = correcting
      ? 'Waiting for the revised worker plan…'
      : 'Waiting for worker results…';
    try {
      this.store.saveMany([parent, child]);
    } catch (error) {
      proposal.childRunId = previous.childRunId;
      proposal.status = previous.status;
      parent.activity = previous.activity;
      throw error;
    }
    this.emitSession(parent);
    this.emitSession(child);
    if (correcting) this.planRuns.add(child.runId!);
    this.launch(child, prompt, correcting ? { readOnly: true } : {});
    return structuredClone(parent);
  }

  stop(input: StopRunInput, reason?: SessionInterruption['reason']): Session {
    const active = this.active.get(input.sessionId);
    if (!active || active.session.runId !== input.runId) {
      const session =
        this.unsaved.get(input.sessionId) ?? this.store.get(input.sessionId);
      if (!session) throw new SessionError('not-found', 'Session not found.');
      return structuredClone(session);
    }
    if (active.finalizing) return structuredClone(active.session);
    if (
      reason &&
      (active.session.status !== 'stopping' || active.session.interruption)
    )
      this.interrupt(active.session, reason);
    active.session.status = 'stopping';
    active.session.activity = 'Stopping…';
    active.session.pendingApprovals = [];
    try {
      this.cancelDelegations(active.session);
      this.publish(active.session);
    } finally {
      void active.handle.stop().catch(() => undefined);
    }
    return structuredClone(active.session);
  }

  respondApproval(input: RespondApprovalInput): Session {
    const active = this.active.get(input.sessionId);
    if (
      !active ||
      active.finalizing ||
      active.session.runId !== input.runId ||
      active.session.status !== 'running' ||
      active.session.mode !== 'supervised' ||
      !('respondApproval' in active.handle) ||
      !active.session.pendingApprovals.some(
        approval => approval.id === input.requestId,
      )
    )
      throw new SessionError(
        'invalid-request',
        'This approval request is no longer active in this session.',
      );
    const pending = active.session.pendingApprovals;
    active.session.pendingApprovals = pending.filter(
      approval => approval.id !== input.requestId,
    );
    try {
      this.publish(active.session);
    } catch (error) {
      active.session.pendingApprovals = pending;
      throw error;
    }
    try {
      active.handle.respondApproval(input.requestId, input.decision);
    } catch {
      void active.handle.stop().catch(() => undefined);
      throw new SessionError(
        'invalid-request',
        'Your decision could not be delivered. The session is stopping.',
      );
    }
    return structuredClone(active.session);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.reviewDecision?.abort();
    const runs = [...this.active.values()];
    for (const active of runs) {
      if (active.finalizing) continue;
      try {
        this.stop(
          {
            sessionId: active.session.id,
            runId: active.session.runId!,
          },
          'host-shutdown',
        );
      } catch {
        void active.handle.stop().catch(() => undefined);
      }
    }
    await Promise.all(runs.map(active => active.finished));
    this.list();
  }

  private interrupt(
    session: Session,
    reason: SessionInterruption['reason'],
  ): void {
    if (!session.runId) return;
    session.interruption = {
      runId: session.runId,
      reason,
      at: new Date().toISOString(),
    };
    const message = session.messages.find(
      item => item.runId === session.runId && item.author === 'agent',
    );
    if (message) message.interruption = session.interruption;
  }

  private recoveryPrompt(session: Session, prompt: string): string {
    if (!session.interruption || session.interruption.runId !== session.runId)
      return prompt;
    const previous = session.messages.find(
      message =>
        message.runId === session.runId && message.author === 'operator',
    );
    const workers = session.delegations
      .filter(proposal => proposal.runId === session.runId)
      .map(proposal => ({
        delegationId: proposal.id,
        childSessionId: proposal.childSessionId,
        childRunId: proposal.childRunId ?? null,
        status: proposal.status,
        task: proposal.task.slice(0, 4000),
        scope: proposal.scope,
        error: proposal.error,
      }));
    return `${prompt}\n\nRecovery context supplied by the host, not authorization to repeat previous operations:\nThe previous run ${session.runId} was interrupted (${session.interruption.reason}); its full outcome is unconfirmed. Inspect the current workspace before retrying any operation. No pending approval or worker decision remains valid. Follow the current user request; do not automatically replay the previous task.\nPrevious request: ${JSON.stringify(previous?.body.slice(0, 12000) ?? '')}\nPrevious worker outcomes: ${JSON.stringify(workers)}`;
  }

  private prepareRun(
    session: Session,
    messageId: string,
    text: string,
    skillId?: string,
    skillHash?: string,
    origin: 'workflow' | null = null,
  ): void {
    this.ensureWorktreeOpen(session);
    const now = new Date();
    const budget = this.options.checkCostBudgets?.(session, now);
    if (budget?.refusal) {
      if (session.scheduledJobRunId && !session.runId) {
        session.error = budget.refusal;
        this.publish(session);
      }
      throw new BudgetRefusal(budget.refusal);
    }
    const runId = randomUUID();
    if (!session.providerInitialized && session.runId)
      session.providerSessionId =
        session.provider === 'Claude Code' ? randomUUID() : null;
    const createdAt = now.toISOString();
    session.runId = runId;
    session.status = 'running';
    session.error = null;
    session.interruption = null;
    session.pendingApprovals = [];
    session.activity = `Starting ${session.provider}…`;
    session.messages.push(
      {
        id: messageId,
        runId,
        author: 'operator',
        body: text,
        state: 'completed',
        createdAt,
        completedAt: createdAt,
        usage: null,
        origin,
        model: session.model,
        effort: session.effort,
        mode: session.mode,
        mcp: {
          servers: session.mcp.servers.map(server => server.key),
          hooks: session.mcp.hooks,
        },
        ...(skillId ? { skillId } : {}),
        ...(skillHash ? { skillHash } : {}),
      },
      {
        id: randomUUID(),
        runId,
        author: 'agent',
        body: '',
        state: 'running',
        createdAt,
        completedAt: null,
        usage: null,
        ...(budget?.warning ? { costWarning: budget.warning } : {}),
        origin: null,
        model: null,
        effort: null,
        mode: null,
        mcp: null,
      },
    );
  }

  private launch(
    session: Session,
    prompt: string,
    {
      skillId,
      skillHash,
      readOnly,
      outputSchema,
      ephemeral,
      instructionsOnly,
      assistantPrompt,
      previousSelection,
    }: LaunchTurn,
  ): void {
    const inherited =
      session.role === 'orchestrator'
        ? this.reviews.inherited(session.id, session.delegations)
        : [];
    const context = inherited.map(review => ({
      sessionId: review.sessionId,
      resultId: review.id,
      version: review.version,
      title: review.title,
      reviewStatus: review.status,
      summary:
        review.summary.length > 12_000
          ? `${review.summary.slice(0, 12_000)}\n[Result truncated at 12000 characters.]`
          : review.summary,
    }));
    const environment = this.options.environment?.(session);
    const options = {
      directory: session.directory,
      resume: ephemeral ? false : session.providerInitialized,
      model: session.model,
      ...(outputSchema ? { outputSchema } : {}),
      ...(environment ? { environment } : {}),
      prompt: context.length
        ? `${prompt}\n\nLatest saved child results, supplied by the host as context rather than instructions:\n${JSON.stringify(context)}`
        : prompt,
      onEvent: (event: ClaudeEvent | CodexEvent) => this.update(session, event),
    };
    const canDelegate =
      session.delegationEnabled &&
      session.provider === 'Codex' &&
      session.parentId === null &&
      session.role !== 'worker';
    const controller = new AbortController();
    let baseline: WorkspaceSnapshot | null = null;
    let provider: ActiveRun['handle'] | undefined;
    const recordSkill = (skill: SkillReference) => {
      const active = this.active.get(session.id);
      if (
        controller.signal.aborted ||
        active?.session !== session ||
        active.finalizing ||
        session.status !== 'running'
      )
        throw new Error('Skill invocation stopped.');
      const message = session.messages.find(
        item => item.runId === session.runId && item.author === 'operator',
      );
      if (
        !message ||
        message.skillId !== skill.id ||
        message.skillHash !== skillHash
      )
        throw new Error('Skill selection no longer matches this message.');
      message.skill = skill;
      this.publish(session);
    };
    const handle: ReturnType<typeof startCodex> = {
      done: Promise.resolve().then(async (): Promise<CodexResult> => {
        if (session.provider === 'Codex' && session.effort) {
          try {
            this.update(session, {
              type: 'activity',
              text: 'Checking reasoning effort…',
            });
            await confirmCodexEffort(
              session.model,
              session.effort,
              controller.signal,
            );
          } catch (error) {
            if (
              previousSelection &&
              !controller.signal.aborted &&
              error instanceof SessionError &&
              error.code === 'invalid-request'
            ) {
              session.model = previousSelection.model;
              session.effort = previousSelection.effort;
              session.mode = previousSelection.mode;
            }
            return controller.signal.aborted
              ? { status: 'stopped', error: null }
              : {
                  status: 'failed',
                  error: `${
                    error instanceof Error
                      ? error.message.slice(0, 700)
                      : 'The reasoning effort could not be confirmed.'
                  } No provider turn was started.`,
                };
          }
        }
        let selected:
          Awaited<ReturnType<typeof resolveSessionSkill>> | undefined;
        if (skillId) {
          try {
            this.update(session, {
              type: 'activity',
              text: 'Checking selected skill…',
            });
            selected = await resolveSessionSkill(
              session,
              skillId,
              skillHash,
              controller.signal,
            );
            if (selected.reference.delivery === 'instructions')
              recordSkill(selected.reference);
          } catch (error) {
            return controller.signal.aborted
              ? { status: 'stopped', error: null }
              : {
                  status: 'failed',
                  error:
                    error instanceof Error
                      ? error.message.slice(0, 800)
                      : 'The selected skill could not be verified.',
                };
          }
        }
        let turnMcp: TurnMcp | null = null;
        if (
          !readOnly &&
          isWritableSessionMode(session.mode) &&
          (session.mcp.servers.length || session.mcp.hooks)
        ) {
          try {
            if (session.mcp.servers.length)
              this.update(session, {
                type: 'activity',
                text: 'Checking MCP servers…',
              });
            turnMcp = await prepareTurnMcp(
              this.fingerprintKey(),
              session.provider,
              session.directory,
              session.mcp,
              controller.signal,
            );
          } catch (error) {
            return controller.signal.aborted
              ? { status: 'stopped', error: null }
              : {
                  status: 'failed',
                  error:
                    error instanceof McpError
                      ? error.message
                      : 'The MCP configuration could not be read. No provider turn was started.',
                };
          }
        }
        if (isWritableSessionMode(session.mode))
          baseline = await captureWorkspace(
            session.directory,
            controller.signal,
          );
        if (controller.signal.aborted)
          return { status: 'stopped', error: null };
        provider =
          session.provider === 'Codex'
            ? startCodex({
                ...options,
                sessionId: session.providerSessionId,
                mode:
                  session.mode === 'supervised' ? 'supervised' : 'read-only',
                effort: session.effort,
                ...(readOnly ? { turnSandbox: 'read-only' as const } : {}),
                ...(instructionsOnly ? { instructionsOnly } : {}),
                ...(turnMcp
                  ? {
                      mcp: {
                        servers: turnMcp.definitions,
                        hooks: turnMcp.hooks,
                      },
                    }
                  : {}),
                ...(selected
                  ? {
                      skillId: selected.native!.id,
                      ...(selected.rootsSupported
                        ? { skillRoots: [dirname(selected.native!.path!)] }
                        : {}),
                      onSkillResolved: async (skill: SkillReference) => {
                        if (skill.id !== selected!.native!.id)
                          throw new Error(
                            'The native skill no longer matches the selection.',
                          );
                        if (selected!.reference.contentHash) {
                          const snapshot = await readSkillSnapshot(
                            skill.path,
                            controller.signal,
                          );
                          if (
                            (process.platform === 'win32'
                              ? snapshot.path.toLowerCase() !==
                                selected!.reference.path.toLowerCase()
                              : snapshot.path !== selected!.reference.path) ||
                            snapshot.contentHash !==
                              selected!.reference.contentHash
                          )
                            throw new Error(
                              'The selected skill changed before the provider turn.',
                            );
                          const foreign = selected!.reference.origins?.some(
                            origin => origin !== 'Codex',
                          );
                          if (foreign && skillCompatibility(snapshot, 'Codex'))
                            throw new Error(
                              'The selected skill is no longer compatible with Codex.',
                            );
                        }
                        recordSkill(selected!.reference);
                      },
                    }
                  : {}),
                ...(canDelegate
                  ? {
                      delegationSchema: delegationToolSchema,
                      onDelegate: (input: unknown, signal: AbortSignal) =>
                        this.delegate(session, input, signal),
                    }
                  : {}),
              })
            : startClaude({
                ...options,
                ...(selected?.snapshot
                  ? {
                      prompt: sharedSkillPrompt(
                        selected.snapshot,
                        options.prompt,
                      ),
                    }
                  : {}),
                ...(ephemeral ? { ephemeral } : {}),
                ...(instructionsOnly ? { instructionsOnly } : {}),
                ...(assistantPrompt ? { assistantPrompt } : {}),
                ...(turnMcp
                  ? {
                      mcp: {
                        servers: turnMcp.definitions,
                        hooks: turnMcp.hooks,
                      },
                    }
                  : {}),
                mode: readOnly ? 'read-only' : session.mode,
                sessionId: session.providerSessionId!,
              });
        return provider.done;
      }),
      stop: async () => {
        controller.abort();
        await provider?.stop();
      },
      respondApproval: (id, decision) => {
        if (!provider || !('respondApproval' in provider))
          throw new Error('Provider is not awaiting approval');
        provider.respondApproval(id, decision);
      },
    };
    const active: ActiveRun = {
      session,
      handle,
      finished: Promise.resolve(),
      evictedActivities: new Set(),
    };
    this.active.set(session.id, active);
    active.finished = handle.done
      .then(async result => {
        active.finalizing = true;
        const { limit, modeUnavailable } = result as ClaudeResult;
        if (modeUnavailable && previousSelection) {
          session.model = previousSelection.model;
          session.effort = previousSelection.effort;
          session.mode = previousSelection.mode;
        }
        if (limit && session.runId && !active.persistenceError)
          this.rememberLimit(session.runId, limit);
        if (
          result.structured !== undefined &&
          session.runId &&
          !active.persistenceError
        )
          this.rememberStructured(session.runId, result.structured);
        if (result.status === 'completed' || result.status === 'failed') {
          session.interruption = null;
          session.messages.at(-1)!.interruption = null;
        }
        if (
          result.interruption &&
          session.interruption?.reason !== 'host-shutdown'
        )
          this.interrupt(session, result.interruption);
        if (active.timer) clearTimeout(active.timer);
        this.cancelDelegations(session);
        const children = [...this.active.values()].filter(
          child =>
            child.session.parentId === session.id &&
            child.session.parentRunId === session.runId,
        );
        await Promise.all(children.map(child => child.finished));
        if (baseline && result.status === 'completed') this.flushStream(active);
        else this.clearStreamTimer(active);
        const shuttingDown = session.interruption?.reason === 'host-shutdown';
        session.status = active.persistenceError
          ? 'failed'
          : shuttingDown
            ? 'interrupted'
            : result.status;
        session.error = active.persistenceError
          ? 'The conversation could not be saved. The response was stopped.'
          : shuttingDown
            ? 'The host shut down before the run finished. Inspect the workspace before continuing; no task was replayed.'
            : result.error;
        session.activity = null;
        session.pendingApprovals = [];
        if (session.status !== 'completed') holdQueue(session);
        session.messages.at(-1)!.state = session.status;
        session.messages.at(-1)!.completedAt = new Date().toISOString();
        session.messages.at(-1)!.usage = result.usage ?? null;
        finishActivities(session, session.status);
        const diff: ReviewDiff =
          baseline && session.status === 'completed'
            ? compareWorkspace(
                baseline,
                await captureWorkspace(session.directory, controller.signal),
              )
            : {
                status: 'not-applicable',
                detail:
                  'Read-only session. Review covers the saved response, without a file diff.',
                patch: '',
                files: [],
                fingerprint: null,
              };
        baseline = null;
        await this.saveTerminal(session, diff);
      })
      .catch(async () => {
        active.finalizing = true;
        this.cancelDelegations(session);
        const children = [...this.active.values()].filter(
          child =>
            child.session.parentId === session.id &&
            child.session.parentRunId === session.runId,
        );
        await Promise.all(children.map(child => child.finished));
        this.clearStreamTimer(active);
        session.status = 'failed';
        session.error =
          'The response could not be saved or finalized. Refresh the session before continuing.';
        session.activity = null;
        session.pendingApprovals = [];
        holdQueue(session);
        session.messages.at(-1)!.state = 'failed';
        session.messages.at(-1)!.completedAt ??= new Date().toISOString();
        finishActivities(session, 'failed');
        try {
          this.publish(session);
        } catch {
          session.revision += 1;
          this.unsaved.set(session.id, session);
          this.emitSession(session);
        }
      })
      .finally(() => {
        baseline = null;
        if (active.timer) clearTimeout(active.timer);
        if (this.active.get(session.id) === active)
          this.active.delete(session.id);
        this.finishWorker(session);
        this.notifyFinished(session);
        if (!this.unsaved.has(session.id)) this.startNextQueued(session);
      });
  }

  private notifyFinished(session: Session): void {
    if (!session.runId) return;
    const review = this.reviews.latest(session.id);
    const finished: RunFinished = {
      sessionId: session.id,
      runId: session.runId,
      workflowRunId: session.workflowRunId,
      status: session.status,
      reviewId:
        session.status === 'completed' && review?.runId === session.runId
          ? review.id
          : null,
    };
    for (const listener of this.finishedListeners) {
      try {
        listener(finished);
      } catch {
        continue;
      }
    }
  }

  private async saveTerminal(
    session: Session,
    diff: ReviewDiff,
  ): Promise<void> {
    const reviews =
      session.status === 'completed' &&
      !session.workflowStepId &&
      !(session.runId && this.planRuns.has(session.runId))
        ? [
            ...this.reviews.supersededBy(session.id),
            this.reviews.result(session, diff),
          ]
        : [];
    for (let attempt = 0; ; attempt++) {
      try {
        this.store.saveMany([session], () => this.reviews.saveMany(reviews));
        this.emitSession(session);
        this.emitReviews(reviews);
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }

  private async delegate(
    parent: Session,
    input: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw new Error('Delegation stopped.');
    const active = this.active.get(parent.id);
    if (!active || active.finalizing || parent.status !== 'running')
      throw new Error('The orchestrator run is no longer active.');
    const parsed = delegationToolInputSchema.safeParse(input);
    if (!parsed.success)
      return JSON.stringify({
        error:
          'Invalid worker proposal. Provide one or two supported workers with explicit tasks and scopes.',
      });
    const previous = parent.delegations.filter(
      item => item.runId === parent.runId,
    );
    if (previous.length + parsed.data.workers.length > 2)
      return JSON.stringify({
        error:
          'A root run can propose at most two workers across all tool calls.',
      });
    if (parent.delegations.length + parsed.data.workers.length > 100)
      return JSON.stringify({
        error:
          'This conversation reached the delegation history limit. Create a new session.',
      });
    const proposals: Delegation[] = parsed.data.workers.map(worker => ({
      ...worker,
      id: randomUUID(),
      runId: parent.runId!,
      status: 'pending',
      childSessionId: null,
      error: null,
      plan: null,
      planRound: 0,
    }));
    try {
      this.validateWorkerDirectories(parent, [...previous, ...proposals]);
    } catch (error) {
      return JSON.stringify({
        error:
          error instanceof Error ? error.message : 'Invalid worker directory.',
      });
    }
    const results = proposals.map(
      proposal =>
        new Promise<WorkerResult>(resolve =>
          this.waiters.set(proposal.id, resolve),
        ),
    );
    const previousRole = parent.role;
    parent.role = 'orchestrator';
    parent.delegations.push(...proposals);
    parent.activity = 'Waiting for worker approval…';
    try {
      this.publish(parent);
    } catch (error) {
      parent.delegations.splice(parent.delegations.length - proposals.length);
      parent.role = previousRole;
      for (const proposal of proposals) this.waiters.delete(proposal.id);
      throw error;
    }
    const abort = () => this.cancelDelegations(parent);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const completed = await Promise.all(results);
      if (signal.aborted) throw new Error('Delegation stopped.');
      return JSON.stringify({ results: completed });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private cancelDelegations(parent: Session): void {
    let changed = false;
    const cancelled: Delegation[] = [];
    for (const proposal of parent.delegations) {
      if (proposal.runId !== parent.runId) continue;
      if (proposal.status === 'pending') {
        proposal.status = parent.interruption ? 'interrupted' : 'stopped';
        if (parent.interruption)
          proposal.error =
            'The parent run ended before this worker was started.';
        cancelled.push(proposal);
        changed = true;
      } else if (proposal.status === 'plan-ready') {
        proposal.status = parent.interruption ? 'interrupted' : 'stopped';
        if (parent.interruption)
          proposal.error =
            'The parent run ended before this worker plan was accepted.';
        cancelled.push(proposal);
        changed = true;
      } else if (isActiveDelegation(proposal) && proposal.childSessionId) {
        const child = this.active.get(proposal.childSessionId);
        if (child && !child.finalizing) {
          try {
            this.stop(
              {
                sessionId: child.session.id,
                runId: child.session.runId!,
              },
              parent.interruption?.reason === 'host-shutdown'
                ? 'host-shutdown'
                : undefined,
            );
          } catch {
            void child.handle.stop().catch(() => undefined);
          }
        }
      }
    }
    if (changed) {
      try {
        this.publish(parent);
      } catch {
        this.unsaved.set(parent.id, parent);
      }
      for (const proposal of cancelled) this.settle(proposal);
    }
  }

  private finishWorker(child: Session): void {
    if (child.runId) this.planRuns.delete(child.runId);
    if (!child.parentId || !child.parentRunId) return;
    const parent = this.active.get(child.parentId)?.session;
    const proposal = parent?.delegations.find(
      item =>
        item.childSessionId === child.id &&
        item.runId === child.parentRunId &&
        (!item.childRunId || item.childRunId === child.runId),
    );
    if (!parent || !proposal || !isActiveDelegation(proposal)) return;
    if (proposal.status === 'planning' && child.status === 'completed') {
      this.readyPlan(parent, proposal, child);
      return;
    }
    proposal.status =
      child.status === 'completed' ||
      child.status === 'stopped' ||
      child.status === 'interrupted'
        ? child.status
        : 'failed';
    proposal.error = child.error;
    try {
      this.publish(parent);
    } catch {
      this.unsaved.set(parent.id, parent);
      const active = this.active.get(parent.id);
      if (active) {
        active.persistenceError = true;
        void active.handle.stop().catch(() => undefined);
      }
    }
    this.settle(proposal, child);
  }

  private readyPlan(
    parent: Session,
    proposal: Delegation,
    child: Session,
  ): void {
    const plan = this.workerText(child);
    proposal.status = 'plan-ready';
    proposal.plan =
      plan.length > WORKER_PLAN_LIMIT ? plan.slice(0, WORKER_PLAN_LIMIT) : plan;
    proposal.planRound += 1;
    proposal.error = null;
    parent.activity = 'Waiting for your decision on the worker plan…';
    try {
      this.publish(parent);
    } catch {
      this.unsaved.set(parent.id, parent);
      const active = this.active.get(parent.id);
      if (active) {
        active.persistenceError = true;
        void active.handle.stop().catch(() => undefined);
      }
    }
  }

  private workerText(child: Session): string {
    return child.messages
      .filter(
        message => message.runId === child.runId && message.author === 'agent',
      )
      .map(message => message.body)
      .join('\n');
  }

  private settle(proposal: Delegation, child?: Session): void {
    const text = child ? this.workerText(child) : '';
    this.waiters.get(proposal.id)?.({
      delegationId: proposal.id,
      childSessionId: proposal.childSessionId,
      status: proposal.status,
      text:
        text.length > 12_000
          ? `${text.slice(0, 12_000)}\n[Worker result truncated at 12000 characters.]`
          : text,
      error: proposal.error?.slice(0, 2000) ?? null,
    });
    this.waiters.delete(proposal.id);
  }

  private validateWorkerDirectories(
    parent: Session,
    proposals: Delegation[],
  ): void {
    if (
      isWritableSessionMode(parent.mode) &&
      proposals.some(proposal => isWritableSessionMode(proposal.mode))
    )
      throw new SessionError(
        'invalid-request',
        'A session with write access can delegate read-only workers. Start a read-only session to delegate file changes.',
      );
    const directories = proposals.map(proposal => {
      const proposed = this.workerDirectory(parent, proposal.directory);
      if (!proposal.childSessionId) return proposed;
      const child =
        this.active.get(proposal.childSessionId)?.session ??
        this.store.get(proposal.childSessionId);
      return child ? this.resolveDirectory(child.directory) : proposed;
    });
    for (let left = 0; left < proposals.length; left++) {
      for (let right = left + 1; right < proposals.length; right++) {
        if (
          !isWritableSessionMode(proposals[left]!.mode) &&
          !isWritableSessionMode(proposals[right]!.mode)
        )
          continue;
        if (
          this.within(directories[left]!, directories[right]!) ||
          this.within(directories[right]!, directories[left]!)
        )
          throw new SessionError(
            'invalid-directory',
            'Worker directories must not overlap when either worker has write access.',
          );
      }
    }
  }

  private workerDirectory(parent: Session, directory: string): string {
    if (
      isAbsolute(directory) ||
      /^[A-Za-z]:/.test(directory) ||
      directory.split(/[\\/]/).includes('..')
    )
      throw new SessionError(
        'invalid-directory',
        'A worker requires an existing relative directory inside the session workspace.',
      );
    const root = this.resolveDirectory(parent.directory);
    const target = this.resolveDirectory(resolve(root, directory));
    if (!this.within(root, target))
      throw new SessionError(
        'invalid-directory',
        'The worker directory is outside the session workspace.',
      );
    return target;
  }

  private within(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return (
      path === '' ||
      (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
    );
  }

  private update(session: Session, event: ClaudeEvent | CodexEvent): void {
    const active = this.active.get(session.id);
    if (active?.finalizing) return;
    if (event.type === 'tool-activity') {
      if (
        !active ||
        !updateActivity(session, event.activity, active.evictedActivities)
      )
        return;
      session.activity =
        event.activity.status === 'running' ? event.activity.title : null;
    } else if (event.type === 'init') {
      if (
        (session.providerInitialized || session.provider === 'Claude Code') &&
        event.sessionId !== session.providerSessionId
      )
        throw new Error('Provider session mismatch');
      session.providerSessionId = event.sessionId;
      session.providerInitialized = true;
      session.actualModel = event.model;
      session.activity = `${session.provider} is working…`;
      this.publish(session);
      return;
    } else if (event.type === 'approval') {
      if (session.status !== 'running') return;
      if (session.provider !== 'Codex' || session.mode !== 'supervised')
        throw new Error('Unexpected provider approval');
      if (
        session.pendingApprovals.some(
          approval => approval.id === event.approval.id,
        )
      )
        throw new Error('Duplicate provider approval');
      session.pendingApprovals.push(event.approval);
      session.activity = 'Waiting for your decision…';
      this.publish(session);
      return;
    } else if (event.type === 'approval-resolved') {
      session.pendingApprovals = session.pendingApprovals.filter(
        approval => approval.id !== event.id,
      );
      if (session.status === 'running' && !session.pendingApprovals.length)
        session.activity = `${session.provider} is working…`;
      this.publish(session);
      return;
    } else if (event.type === 'text') {
      session.messages.at(-1)!.body = event.text;
      session.activity = session.status === 'stopping' ? 'Stopping…' : null;
    } else if (session.status !== 'stopping') {
      session.activity = event.text;
    }
    if (session.pendingApprovals.length)
      session.activity = 'Waiting for your decision…';
    if (!active) return;
    active.persistTimer ??= setTimeout(
      () => this.flushStream(active),
      STREAM_PERSIST_INTERVAL,
    );
    if (!active.timer) {
      active.timer = setTimeout(() => {
        active.timer = undefined;
        session.revision += 1;
        session.updatedAt = new Date().toISOString();
        this.emitSession(session);
      }, 75);
    }
  }

  private flushStream(active: ActiveRun): void {
    if (!active.persistTimer) return;
    this.clearStreamTimer(active);
    try {
      this.store.save(active.session);
    } catch {
      active.persistenceError = true;
      this.cancelDelegations(active.session);
      void active.handle.stop().catch(() => undefined);
    }
  }

  private clearStreamTimer(active: ActiveRun): void {
    clearTimeout(active.persistTimer);
    active.persistTimer = undefined;
  }

  private emitSession(session: Session): void {
    this.emit({ type: 'session-changed', session: structuredClone(session) });
  }

  private publish(session: Session): void {
    this.store.save(session);
    const active = this.active.get(session.id);
    if (active) this.clearStreamTimer(active);
    this.emitSession(session);
  }

  private resolveDirectory(directory: string): string {
    try {
      if (!isAbsolute(directory) || !statSync(directory).isDirectory())
        throw new Error('Invalid directory');
      return realpathSync(directory);
    } catch {
      throw new SessionError(
        'invalid-directory',
        'The directory does not exist or cannot be accessed. Enter its absolute path.',
      );
    }
  }
}
