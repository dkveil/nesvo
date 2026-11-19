import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createSessionSchema,
  isProviderSessionMode,
  isWritableSessionMode,
  isSessionControlToolName,
  isStageToolName,
  latestStageReport,
  pendingStageQuestion,
  sessionControlLimits,
  sessionControlTools,
  stageTools,
  type CoordinatorPolicy,
  type ContinueCoordinatorInput,
  type ContinueWorkerInput,
  type DecideSessionParentInput,
  type Session,
  type SessionControlChild,
  type SessionControlRefusalCode,
  type SessionControlToolInput,
  type SessionControlToolName,
  type SessionMode,
  type SessionStageRecord,
  type StageToolInput,
  type StageToolName,
} from '@nesvo/contracts';
import {
  isCoordinatorCandidate,
  type RunFinished,
  type SessionService,
} from '../sessions/service';
import { SessionError } from '../sessions/session-error';
import { ProviderUsageHeld } from '../providers/usage-gates';
import {
  actorLabel,
  coordinatorActor,
  decisionMessageId,
  derivedUuid,
  hasStageTools,
  QUESTION_RECORDED_MESSAGE,
} from '../sessions/stages';
import type { SessionControlStore } from './store';
import { WorkspaceIsolationError } from '../workspace/isolation';
import type {
  SessionControlBridge,
  SessionControlCall,
  SessionControlCaller,
  SessionControlReply,
} from './types';

type SessionControlParams = {
  store: SessionControlStore;
  sessions: SessionService;
  signal: AbortSignal;
};

type Handler<T extends SessionControlToolName> = (context: {
  coordinator: Session;
  input: SessionControlToolInput<T>;
  actionId: string;
  policy: CoordinatorPolicy;
  signal: AbortSignal;
}) => Promise<SessionControlReply> | SessionControlReply;

const SEEN_APPROVALS_LIMIT = 1000;

const success = (data: Record<string, unknown>): SessionControlReply => ({
  ok: true,
  text: JSON.stringify({ ok: true, ...data }),
});

const refusal = (
  code: SessionControlRefusalCode,
  message: string,
): SessionControlReply => ({
  ok: false,
  text: JSON.stringify({ ok: false, code, message }),
});

class ChildRefusal extends SessionError {
  constructor(
    readonly refusal: SessionControlRefusalCode,
    message: string,
  ) {
    super('invalid-request', message);
  }
}

const refusalFor = (error: unknown): SessionControlReply => {
  if (error instanceof ProviderUsageHeld)
    return {
      ok: false,
      text: JSON.stringify({
        ok: false,
        code: 'usage-held',
        message: error.message,
        hold: error.hold,
      }),
    };
  if (error instanceof WorkspaceIsolationError)
    return refusal('invalid', error.message);
  if (error instanceof ChildRefusal)
    return refusal(error.refusal, error.message);
  if (!(error instanceof SessionError))
    return refusal('unsupported', 'Nesvo could not complete this call.');
  const code: SessionControlRefusalCode =
    error.code === 'busy'
      ? 'busy'
      : error.code === 'not-found'
        ? 'not-found'
        : error.code === 'unavailable'
          ? 'unsupported'
          : 'invalid';
  return refusal(code, error.message);
};

const derivedId = derivedUuid;

const lastReply = (session: Session) =>
  session.messages.findLast(message => message.author === 'agent');

const insideFolder = (parent: string, child: string) => {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
};

const childDirectory = (coordinator: Session, requested: string) => {
  let root: string;
  let directory: string;
  try {
    root = realpathSync(coordinator.directory);
    directory = realpathSync(
      isAbsolute(requested)
        ? requested
        : resolve(coordinator.directory, requested),
    );
  } catch {
    return null;
  }
  return insideFolder(root, directory) ? directory : null;
};

type ChildPlacement = { directory?: string; folderNote?: string };

const childPlacement = (
  coordinator: Session,
  requested: string | undefined,
  defaultFolder: string | null,
): ChildPlacement | null => {
  if (requested) {
    const directory = childDirectory(coordinator, requested);
    return directory ? { directory } : null;
  }
  if (defaultFolder && childDirectory(coordinator, defaultFolder)) return {};
  const directory = childDirectory(coordinator, '.');
  if (!directory) return null;
  const reason = defaultFolder
    ? 'The default session folder is outside your folder'
    : 'This computer has no default session folder';
  return {
    directory,
    folderNote: `${reason}, so the child works in your folder (${basename(directory)}).`,
  };
};

const allowedModes = (policy: CoordinatorPolicy) =>
  policy.childModes.length ? policy.childModes.join(', ') : 'no modes';

export class SessionControl {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly inFlight = new Map<string, Promise<SessionControlReply>>();
  private readonly creating = new Map<string, number>();
  private readonly seenApprovals = new Set<string>();

  constructor(private readonly params: SessionControlParams) {}

  bridge(): SessionControlBridge {
    return {
      available: session => this.eligible(session, this.policy()),
      call: (caller, call, signal) => this.call(caller, call, signal),
    };
  }

  private eligible(session: Session, policy: CoordinatorPolicy): boolean {
    if (!policy.enabled) return false;
    if (isCoordinatorCandidate(session)) return true;
    if (
      !policy.nested ||
      !session.parentId ||
      session.workflowRunId ||
      session.scheduledJobId ||
      session.workflowStepId
    )
      return false;
    const parent = this.params.sessions.snapshot(session.parentId);
    return !!parent && isCoordinatorCandidate(parent);
  }

  policy(): CoordinatorPolicy {
    return this.params.store.policy();
  }

  savePolicy(policy: CoordinatorPolicy): CoordinatorPolicy {
    return this.params.store.savePolicy(policy);
  }

  async call(
    caller: SessionControlCaller,
    call: SessionControlCall,
    signal: AbortSignal,
  ): Promise<SessionControlReply> {
    if (call.tool === 'nesvo_delegate')
      call = { ...call, tool: 'session_delegate' };
    const stage = isStageToolName(call.tool);
    if (!stage && !isSessionControlToolName(call.tool))
      return refusal('unsupported', `Nesvo has no tool named ${call.tool}.`);
    const tool = call.tool as SessionControlToolName | StageToolName;
    if (!isStageToolName(tool) && !sessionControlTools[tool].mutation)
      return this.execute(caller, tool, call.input, '', signal);
    const actionId = createHash('sha256')
      .update(`${caller.sessionId}\n${call.callId}`)
      .digest('hex');
    const stored = this.params.store.action(actionId);
    if (stored) return JSON.parse(stored.result) as SessionControlReply;
    const running = this.inFlight.get(actionId);
    if (running) return running;
    const execution = (
      isStageToolName(tool)
        ? Promise.resolve(this.executeStage(caller, tool, call.input, actionId))
        : this.execute(caller, tool, call.input, actionId, signal)
    )
      .then(reply => {
        const recorded = reply.ok
          ? {
              ok: true,
              text: JSON.stringify({ ...JSON.parse(reply.text), actionId }),
            }
          : reply;
        this.params.store.saveAction(
          actionId,
          caller.sessionId,
          tool,
          JSON.stringify(recorded),
        );
        return recorded;
      })
      .finally(() => this.inFlight.delete(actionId));
    this.inFlight.set(actionId, execution);
    return execution;
  }

  continueWorker(input: ContinueWorkerInput): Session {
    const parent = this.params.sessions.snapshot(input.sessionId);
    const worker = this.params.sessions.snapshot(input.workerId);
    if (!parent || worker?.parentId !== parent.id)
      throw new SessionError(
        'not-found',
        'This worker does not belong to the coordinator.',
      );
    return this.params.sessions.continueWorker(input, parent, worker, () => {
      const root = this.groupRoot(parent);
      const cap = this.policy().groupSize;
      if (
        this.activeWorkerSlots(root) + (this.creating.get(root.id) ?? 0) + 1 >=
        cap
      )
        throw new SessionError(
          'busy',
          `The coordinator group is limited to ${cap} sessions.`,
        );
    });
  }

  continue(input: ContinueCoordinatorInput): Session {
    const wait = this.params.sessions.snapshot(
      input.sessionId,
    )?.coordinatorWait;
    const events =
      wait?.runId === input.waitRunId
        ? this.params.store
            .events(input.sessionId, wait.cursor)
            .events.filter(event => event.at >= wait.startedAt)
            .slice(0, 20)
        : [];
    return this.params.sessions.continueCoordinator(
      input,
      events.map(event => ({
        ...event,
        summary: event.summary.slice(0, 300),
        detail: event.detail?.slice(0, 200),
      })),
    );
  }

  decideParent(input: DecideSessionParentInput): Session {
    const target = this.params.sessions.snapshot(input.sessionId);
    const request = target?.parentRequest;
    if (!target || !request || request.id !== input.requestId)
      throw new SessionError(
        'not-found',
        'This request was already decided. Refresh the Inbox.',
      );
    const coordinator = this.params.sessions.snapshot(request.parentId);
    const accepted = input.decision === 'accept';
    if (
      accepted &&
      (!coordinator ||
        !isCoordinatorCandidate(coordinator) ||
        target.parentId !== null)
    )
      throw new SessionError(
        'invalid-request',
        'The coordinating session is no longer available, so this session cannot join it.',
      );
    const session = this.params.sessions.resolveParentRequest(
      target.id,
      request.id,
      accepted ? request.parentId : null,
    );
    if (accepted)
      this.params.store.saveChild({
        sessionId: target.id,
        parentId: request.parentId,
        planStatus: null,
        planRound: 0,
        targetMode: null,
        plan: null,
      });
    this.record(request.parentId, {
      sessionId: target.id,
      runId: null,
      type: accepted ? 'parent-accepted' : 'parent-declined',
      status: null,
      summary: accepted
        ? `The owner made ${target.title} one of your sessions.`
        : `The owner declined to make ${target.title} one of your sessions.`,
    });
    return session;
  }

  runFinished(finished: RunFinished): void {
    const record = this.params.store.child(finished.sessionId);
    if (!record) return;
    const child = this.params.sessions.snapshot(finished.sessionId);
    if (!child || child.parentId !== record.parentId) return;
    if (
      child.plan?.status === 'plan-ready' &&
      child.plan.runId === finished.runId
    ) {
      this.record(record.parentId, {
        sessionId: child.id,
        runId: finished.runId,
        type: 'plan-ready',
        status: finished.status,
        summary: `${child.title} returned a plan. Read it with session_output and decide with session_decide.`,
      });
      return;
    }
    const completed = finished.status === 'completed';
    this.record(record.parentId, {
      sessionId: child.id,
      runId: finished.runId,
      type: completed ? 'finished' : 'failed',
      status: finished.status,
      summary: completed
        ? `${child.title} finished its turn.`
        : `${child.title} ended as ${finished.status}${child.error ? `: ${child.error}` : '.'}`,
    });
  }

  stageRecorded(session: Session, records: readonly SessionStageRecord[]) {
    const record = this.params.store.child(session.id);
    if (!record || !session.parentId || record.parentId !== session.parentId)
      return;
    for (const entry of records) {
      const event = this.stageEvent(session, entry);
      if (event) this.record(record.parentId, event);
    }
  }

  private stageEvent(
    session: Session,
    entry: SessionStageRecord,
  ): Omit<
    Parameters<SessionControlStore['appendEvent']>[0],
    'parentId'
  > | null {
    const base = {
      sessionId: session.id,
      runId: 'runId' in entry ? entry.runId : session.runId,
      status: session.status,
    };
    if (entry.kind === 'plan-decision') {
      const action =
        entry.decision === 'accept'
          ? `approved the plan of ${session.title}${entry.mode ? ` in ${entry.mode}` : ''}`
          : entry.decision === 'correct'
            ? `asked ${session.title} to correct its plan`
            : `rejected the plan of ${session.title}`;
      return {
        ...base,
        type: 'plan-decided',
        summary: `${actorLabel(entry.by)} ${action}.`,
        detail: entry.text,
      };
    }
    if (entry.kind === 'report')
      return {
        ...base,
        type: 'reported',
        summary: `${session.title} reported ${entry.report.status}. Read the report with session_status.`,
        detail: entry.report.summary,
      };
    if (entry.kind === 'report-invalid')
      return {
        ...base,
        type: 'reported',
        summary: `${session.title} ended with an invalid report.`,
        detail: entry.error,
      };
    if (entry.kind === 'question')
      return entry.status === 'pending'
        ? {
            ...base,
            type: 'question',
            summary: `${session.title} asks a ${entry.question.kind} question.${entry.question.kind === 'technical' ? ' Answer it with session_answer.' : ' The owner answers it.'}`,
            detail: entry.question.question,
          }
        : {
            ...base,
            type: 'question-answered',
            summary: `${entry.answer ? actorLabel(entry.answer.by) : 'The owner'} answered the question of ${session.title}.`,
            detail: [entry.answer?.option, entry.answer?.text]
              .filter(Boolean)
              .join('\n'),
          };
    if (entry.kind === 'progress')
      return {
        ...base,
        type: 'progress',
        summary: `${session.title} shared progress.`,
        detail: entry.text,
      };
    return null;
  }

  private executeStage(
    caller: SessionControlCaller,
    tool: StageToolName,
    input: unknown,
    actionId: string,
  ): SessionControlReply {
    const session = this.params.sessions.snapshot(caller.sessionId);
    if (!session || session.runId !== caller.runId || !hasStageTools(session))
      return refusal(
        'unsupported',
        'Only the running turn of a child or workflow session can use stage tools.',
      );
    const parsed = stageTools[tool].input.safeParse(input);
    if (!parsed.success)
      return refusal(
        'invalid',
        parsed.error.issues
          .slice(0, 5)
          .map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; '),
      );
    const recordId = derivedId(actionId, 'record');
    try {
      if (tool === 'stage_report') {
        this.params.sessions.recordStage(caller, recordId, {
          kind: 'report',
          report: parsed.data as StageToolInput<'stage_report'>,
        });
        return success({ recorded: 'report', recordId });
      }
      if (tool === 'stage_question') {
        this.params.sessions.recordStage(caller, recordId, {
          kind: 'question',
          question: parsed.data as StageToolInput<'stage_question'>,
        });
        return success({
          recorded: 'question',
          questionId: recordId,
          message: QUESTION_RECORDED_MESSAGE,
        });
      }
      this.params.sessions.recordStage(caller, recordId, {
        kind: 'progress',
        text: (parsed.data as StageToolInput<'stage_progress'>).text,
      });
      return success({ recorded: 'progress', recordId });
    } catch (error) {
      return refusalFor(error);
    }
  }

  decisionEvent(
    child: Session,
    type: 'decision-needed' | 'decision-made',
    summary: string,
    detail: string | null,
  ): void {
    const record = this.params.store.child(child.id);
    if (!record || record.parentId !== child.parentId) return;
    this.record(record.parentId, {
      sessionId: child.id,
      runId: child.runId,
      type,
      status: child.status,
      summary,
      detail,
    });
  }

  observe(session: Session): void {
    if (!session.pendingApprovals.length || !session.parentId) return;
    const fresh = session.pendingApprovals.filter(
      approval => !this.seenApprovals.has(`${session.id}:${approval.id}`),
    );
    if (!fresh.length) return;
    const record = this.params.store.child(session.id);
    if (!record || record.parentId !== session.parentId) return;
    if (this.seenApprovals.size > SEEN_APPROVALS_LIMIT)
      this.seenApprovals.clear();
    for (const approval of fresh) {
      this.seenApprovals.add(`${session.id}:${approval.id}`);
      this.record(record.parentId, {
        sessionId: session.id,
        runId: session.runId,
        type: 'approval-pending',
        status: session.status,
        summary: `${session.title} waits for the owner to approve: ${approval.title}. Only the owner can answer it.`,
      });
    }
  }

  private record(
    parentId: string,
    event: Omit<Parameters<SessionControlStore['appendEvent']>[0], 'parentId'>,
  ): void {
    try {
      this.params.store.appendEvent({ parentId, ...event });
    } catch {
      return;
    }
    for (const wake of this.waiters.get(parentId) ?? []) wake();
  }

  private async execute(
    caller: SessionControlCaller,
    tool: SessionControlToolName,
    input: unknown,
    actionId: string,
    signal: AbortSignal,
  ): Promise<SessionControlReply> {
    const policy = this.params.store.policy();
    if (!policy.enabled && tool !== 'session_delegate')
      return refusal(
        'disabled',
        'Session control is turned off in Settings on this computer.',
      );
    const coordinator = this.params.sessions.snapshot(caller.sessionId);
    if (
      !coordinator ||
      coordinator.runId !== caller.runId ||
      coordinator.status !== 'running' ||
      !(
        this.eligible(coordinator, policy) ||
        (!policy.enabled && isCoordinatorCandidate(coordinator))
      )
    )
      return refusal(
        'unsupported',
        'This running session is outside the allowed coordinator group.',
      );
    const parsed = sessionControlTools[tool].input.safeParse(input);
    if (!parsed.success)
      return refusal(
        'invalid',
        parsed.error.issues
          .slice(0, 5)
          .map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; '),
      );
    const handler = this.handlers[tool] as Handler<typeof tool>;
    try {
      return await handler({
        coordinator,
        input: parsed.data as SessionControlToolInput<typeof tool>,
        actionId,
        policy,
        signal,
      });
    } catch (error) {
      return refusalFor(error);
    }
  }

  private groupRoot(session: Session): Session {
    const parent =
      session.parentId && this.params.sessions.snapshot(session.parentId);
    return parent ? this.groupRoot(parent) : session;
  }

  private activeWorkerSlots(root: Session): number {
    const snapshots = this.params.sessions.list();
    const parents = new Set([
      root.id,
      ...snapshots
        .filter(item => item.parentId === root.id)
        .map(item => item.id),
    ]);
    const active = snapshots.filter(
      item =>
        item.parentId &&
        parents.has(item.parentId) &&
        (item.status === 'running' ||
          item.status === 'stopping' ||
          item.queue.some(message => !message.held) ||
          item.plan?.status === 'plan-ready'),
    );
    const proposals = [...parents].flatMap(
      id => this.params.sessions.snapshot(id)?.delegations ?? [],
    );
    return (
      active.length +
      proposals.filter(
        item =>
          item.status === 'pending' ||
          (item.status === 'plan-ready' &&
            !active.some(child => child.id === item.childSessionId)),
      ).length
    );
  }

  private child(coordinator: Session, sessionId: string): Session {
    const child = this.params.sessions.snapshot(sessionId);
    if (!child || child.parentId !== coordinator.id)
      throw new ChildRefusal(
        'not-in-subtree',
        'This session is not one of your child sessions.',
      );
    return child;
  }

  private children(coordinator: Session): Session[] {
    return this.params.sessions
      .list()
      .filter(session => session.parentId === coordinator.id)
      .map(session => this.params.sessions.snapshot(session.id))
      .filter((session): session is Session => !!session);
  }

  private steerableChild(coordinator: Session, sessionId: string): Session {
    const child = this.child(coordinator, sessionId);
    if (child.role === 'worker')
      throw new ChildRefusal(
        'human-only',
        'This worker is bound to its approved task. Use the Inbox for decisions.',
      );
    return child;
  }

  private summary(child: Session): SessionControlChild {
    const window = this.params.sessions.window(child, 1);
    const plan = child.plan?.status;
    const open = pendingStageQuestion(child);
    const question = !!open;
    const running = child.status === 'running' || child.status === 'stopping';
    return {
      sessionId: child.id,
      title: child.title,
      provider: child.provider,
      model: child.model,
      effort: child.effort,
      mode: child.mode,
      directory: child.directory,
      status: child.status,
      error: child.error,
      waitingFor:
        plan === 'plan-ready'
          ? 'plan'
          : question
            ? 'question'
            : child.pendingApprovals.length
              ? 'approval'
              : window.waitingFor
                ? 'folder'
                : child.queue.length && !running
                  ? 'queue'
                  : null,
      needsDecision:
        plan === 'plan-ready' || question || child.pendingApprovals.length > 0,
      queued: child.queue.length,
      lastActivityAt: child.updatedAt,
      pullRequest: child.pullRequest,
      report: latestStageReport(child)?.report ?? null,
      question: open?.question ?? null,
    };
  }

  private delivery(child: Session, messageId: string) {
    const current = this.params.sessions.snapshot(child.id) ?? child;
    const position = current.queue.findIndex(item => item.id === messageId);
    const wait = this.params.sessions.window(current, 1).waitingFor;
    return position === -1
      ? { status: 'started' as const }
      : {
          status: 'queued' as const,
          queuePosition: position + 1,
          ...(wait ? { waitingFor: wait.directory } : {}),
        };
  }

  private refuseModel(
    policy: CoordinatorPolicy,
    model: string | undefined,
  ): SessionControlReply | null {
    if (!model || !policy.models.length || policy.models.includes(model))
      return null;
    return refusal(
      'forbidden-by-policy',
      `The coordinator policy allows only these models: ${policy.models.join(', ')}.`,
    );
  }

  private refuseMode(
    policy: CoordinatorPolicy,
    mode: SessionMode | undefined,
  ): SessionControlReply | null {
    if (!mode || policy.childModes.includes(mode)) return null;
    return refusal(
      'forbidden-by-policy',
      `The coordinator policy does not allow ${mode} for child sessions. Allowed: ${allowedModes(policy)}.`,
    );
  }

  private async refuseWritableDirectory(
    coordinator: Session,
    child: Session,
    mode: Session['mode'],
    signal: AbortSignal,
  ) {
    if (!isWritableSessionMode(mode) || child.worktree) return null;
    if (
      isWritableSessionMode(coordinator.mode) ||
      (await this.params.sessions.workerBase(coordinator, signal))
    )
      return refusal(
        'forbidden-by-policy',
        'Start a new isolated worker for writes to this workspace.',
      );
    return null;
  }

  private wait(parentId: string, milliseconds: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
      const listeners = this.waiters.get(parentId) ?? new Set<() => void>();
      this.waiters.set(parentId, listeners);
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.params.signal.removeEventListener('abort', done);
        listeners.delete(done);
        if (!listeners.size) this.waiters.delete(parentId);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      listeners.add(done);
      signal.addEventListener('abort', done, { once: true });
      this.params.signal.addEventListener('abort', done, { once: true });
    });
  }

  private readonly handlers: {
    [T in SessionControlToolName]: Handler<T>;
  } = {
    session_delegate: async ({
      coordinator,
      policy,
      input,
      actionId,
      signal,
    }) => {
      for (const worker of input.workers) {
        if (!policy.enabled) continue;
        if (!policy.providers.includes(worker.provider))
          return refusal(
            'forbidden-by-policy',
            `The coordinator policy does not allow ${worker.provider} workers.`,
          );
        const refused =
          this.refuseModel(policy, worker.model) ??
          this.refuseMode(policy, worker.mode);
        if (refused) return refused;
      }
      const root = this.groupRoot(coordinator);
      const checkSlots = () => {
        if (
          this.activeWorkerSlots(root) +
            (this.creating.get(root.id) ?? 0) +
            input.workers.length >=
          policy.groupSize
        )
          throw new ChildRefusal(
            'busy',
            `The coordinator group is limited to ${policy.groupSize} sessions.`,
          );
      };
      return this.params.sessions.delegate(
        coordinator.id,
        input.workers.map((worker, index) => ({
          ...worker,
          id: derivedId(actionId, `worker-${index}`),
        })),
        policy.groupSize,
        checkSlots,
        signal,
      );
    },
    session_create: async ({
      coordinator,
      input,
      actionId,
      policy,
      signal,
    }) => {
      const provider = input.provider ?? coordinator.provider;
      if (!policy.providers.includes(provider))
        return refusal(
          'forbidden-by-policy',
          `The coordinator policy does not allow ${provider} child sessions.`,
        );
      const model =
        input.model ??
        (provider === coordinator.provider ? coordinator.model : 'default');
      const refused =
        this.refuseModel(policy, model) ?? this.refuseMode(policy, input.mode);
      if (refused) return refused;
      if (!isProviderSessionMode(provider, input.mode))
        return refusal(
          'invalid',
          `${provider} does not support the ${input.mode} permission mode.`,
        );
      if (input.browser && !policy.browser)
        return refusal(
          'forbidden-by-policy',
          'The coordinator policy does not allow children with browser access.',
        );
      if (input.worktree && !policy.worktrees)
        return refusal(
          'forbidden-by-policy',
          'The coordinator policy does not allow creating worktrees.',
        );
      const groupId = input.groupId ?? coordinator.groupId;
      const placement = childPlacement(
        coordinator,
        input.directory,
        this.params.sessions.defaultDirectory(groupId ?? undefined),
      );
      if (!placement)
        return refusal(
          'forbidden-by-policy',
          `Child sessions work in an existing folder inside your folder (${basename(coordinator.directory)}).`,
        );
      const root = this.groupRoot(coordinator);
      const reserved = this.creating.get(root.id) ?? 0;
      if (this.activeWorkerSlots(root) + reserved + 1 >= policy.groupSize)
        return refusal(
          'busy',
          `The coordinator group is limited to ${policy.groupSize} sessions.`,
        );
      this.creating.set(root.id, reserved + 1);
      try {
        const writable = isWritableSessionMode(input.mode);
        const workerBase = writable
          ? await this.params.sessions.workerBase(coordinator, signal)
          : undefined;
        if (
          workerBase &&
          placement.directory &&
          placement.directory !== childDirectory(coordinator, '.')
        )
          return refusal(
            'invalid',
            'Use the coordinator folder for an isolated writable worker and put narrower boundaries in its task scope.',
          );
        if (workerBase && !policy.worktrees)
          return refusal(
            'forbidden-by-policy',
            'Enable worktrees in the coordinator policy before starting a writable Git worker.',
          );
        if (writable && !workerBase && isWritableSessionMode(coordinator.mode))
          return refusal(
            'forbidden-by-policy',
            'A writable coordinator needs a Git worktree to start a writable worker.',
          );
        const create = createSessionSchema.safeParse({
          requestId: derivedId(actionId, 'create'),
          title: input.title,
          provider,
          model,
          mode: input.mode,
          ...(input.planFirst ? { planFirst: true } : {}),
          ...(placement.directory ? { directory: placement.directory } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(workerBase || input.worktree
            ? {
                isolation: {
                  kind: 'worktree',
                  branch: input.worktree?.branch,
                  task: input.worktree?.task,
                },
              }
            : {}),
          ...(groupId ? { groupId } : {}),
          ...(input.browser ? { browser: true } : {}),
        });
        if (!create.success)
          return refusal(
            'invalid',
            create.error.issues.map(issue => issue.message).join('; '),
          );
        const child = await this.params.sessions.createWithEffort(
          create.data,
          signal,
          coordinator.id,
          workerBase && {
            ...workerBase,
            suggestedBranch: this.params.sessions.workerBranch(
              workerBase.branch,
              actionId,
            ),
          },
        );
        if (!this.params.store.child(child.id))
          this.params.store.saveChild({
            sessionId: child.id,
            parentId: coordinator.id,
            planStatus: null,
            planRound: 0,
            targetMode: null,
            plan: null,
          });
        const messageId = derivedId(actionId, 'message');
        this.params.sessions.queue({
          sessionId: child.id,
          messageId,
          text: workerBase
            ? `${input.prompt}\n\nSave your result as commits on ${child.worktree?.branch}. The operator reviews the diff and decides whether to merge.`
            : input.prompt,
        });
        return success({
          sessionId: child.id,
          messageId,
          ...this.delivery(child, messageId),
          planFirst: input.planFirst,
          ...(placement.folderNote ? { folderNote: placement.folderNote } : {}),
        });
      } finally {
        const remaining = (this.creating.get(root.id) ?? 1) - 1;
        if (remaining) this.creating.set(root.id, remaining);
        else this.creating.delete(root.id);
      }
    },
    session_send: async ({ coordinator, input, actionId, policy, signal }) => {
      const child = this.steerableChild(coordinator, input.sessionId);
      const refused =
        this.refuseModel(policy, input.model) ??
        this.refuseMode(policy, input.mode);
      if (refused) return refused;
      const mode = input.mode ?? child.mode;
      const scope = await this.refuseWritableDirectory(
        coordinator,
        child,
        mode,
        signal,
      );
      if (scope) return scope;
      if (
        child.status !== 'running' &&
        child.status !== 'stopping' &&
        !child.queue.some(item => !item.held)
      ) {
        const root = this.groupRoot(coordinator);
        if (
          this.activeWorkerSlots(root) +
            (this.creating.get(root.id) ?? 0) +
            1 >=
          policy.groupSize
        )
          return refusal(
            'busy',
            `The coordinator group is limited to ${policy.groupSize} sessions.`,
          );
      }
      const messageId = derivedId(actionId, 'message');
      this.params.sessions.queue({
        sessionId: child.id,
        messageId,
        text: input.text,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.mode ? { mode: input.mode } : {}),
      });
      this.params.sessions.recordChildMessage(
        coordinator.id,
        coordinator.runId!,
        child.id,
      );
      return success({
        sessionId: child.id,
        messageId,
        ...this.delivery(child, messageId),
      });
    },
    session_status: ({ coordinator, input }) => {
      const sessions = input.sessionIds
        ? input.sessionIds.map(id => this.child(coordinator, id))
        : this.children(coordinator);
      return success({ sessions: sessions.map(child => this.summary(child)) });
    },
    session_children: ({ coordinator }) =>
      success({
        sessions: this.children(coordinator).map(child => this.summary(child)),
      }),
    session_output: ({ coordinator, input }) => {
      const child = this.child(coordinator, input.sessionId);
      const reply = lastReply(child);
      const body = reply?.body ?? '';
      return success({
        sessionId: child.id,
        messageId: reply?.id ?? null,
        state: reply?.state ?? null,
        text: body.slice(0, input.maxChars),
        truncated: body.length > input.maxChars,
        untrusted: true,
      });
    },
    session_decide: ({ coordinator, input, actionId, policy }) => {
      const child = this.child(coordinator, input.sessionId);
      if (input.kind !== 'plan')
        return refusal(
          'human-only',
          'Operation approvals and worker decisions belong to the computer owner. Tell them in your reply or wait with events_wait.',
        );
      if (!policy.acceptPlans)
        return refusal(
          'forbidden-by-policy',
          'The coordinator policy does not allow deciding plans. The owner decides them.',
        );
      const plan = child.plan;
      if (!plan || plan.status !== 'plan-ready')
        return refusal(
          'invalid',
          'This session has no plan waiting for a decision.',
        );
      if (input.decision === 'accept') {
        const refused = this.refuseMode(policy, plan.targetMode);
        if (refused) return refused;
      }
      if (
        input.decision === 'correct' &&
        plan.round + 1 >= sessionControlLimits.planRounds
      )
        return refusal(
          'invalid',
          `A plan can be corrected at most ${sessionControlLimits.planRounds - 1} times. Accept or decline it.`,
        );
      const decisionId = derivedId(actionId, 'decision');
      const decided = this.params.sessions.decideSessionPlan(
        {
          sessionId: child.id,
          planId: plan.id,
          decisionId,
          decision: input.decision,
          ...(input.text ? { text: input.text } : {}),
          via: 'desktop',
        },
        coordinatorActor(coordinator.id),
      );
      if (input.decision === 'decline')
        return success({ sessionId: child.id, decision: 'decline' });
      const messageId = decisionMessageId(decisionId);
      return success({
        sessionId: child.id,
        decision: input.decision,
        ...(input.decision === 'accept' ? { mode: plan.targetMode } : {}),
        messageId,
        ...this.delivery(decided, messageId),
      });
    },
    session_set_model: ({ coordinator, input, policy }) => {
      const child = this.steerableChild(coordinator, input.sessionId);
      const refused = this.refuseModel(policy, input.model);
      if (refused) return refused;
      const updated = this.params.sessions.changeSelection(child.id, {
        model: input.model,
      });
      return success({
        sessionId: child.id,
        model: updated.model,
        appliesFrom: 'next-turn',
      });
    },
    session_set_effort: ({ coordinator, input }) => {
      const child = this.steerableChild(coordinator, input.sessionId);
      const updated = this.params.sessions.changeSelection(child.id, {
        effort: input.effort,
      });
      return success({
        sessionId: child.id,
        effort: updated.effort,
        appliesFrom: 'next-turn',
      });
    },
    session_set_mode: async ({ coordinator, input, policy, signal }) => {
      const child = this.steerableChild(coordinator, input.sessionId);
      const refused = this.refuseMode(policy, input.mode);
      if (refused) return refused;
      const scope = await this.refuseWritableDirectory(
        coordinator,
        child,
        input.mode,
        signal,
      );
      if (scope) return scope;
      if (!isProviderSessionMode(child.provider, input.mode))
        return refusal(
          'invalid',
          `${child.provider} does not support the ${input.mode} permission mode.`,
        );
      if (
        child.plan?.status === 'planning' ||
        child.plan?.status === 'plan-ready'
      ) {
        this.params.sessions.setPlanTargetMode(child.id, input.mode);
        return success({
          sessionId: child.id,
          mode: input.mode,
          appliesFrom: 'accepted-plan',
        });
      }
      const updated = this.params.sessions.changeSelection(
        child.id,
        { mode: input.mode },
        coordinatorActor(coordinator.id),
      );
      return success({
        sessionId: child.id,
        mode: updated.mode,
        appliesFrom: 'next-turn',
      });
    },
    session_set_parent: ({ coordinator, input, actionId }) => {
      const target = this.params.sessions.snapshot(input.sessionId);
      if (!target) return refusal('not-found', 'This session does not exist.');
      if (target.parentId === coordinator.id)
        return success({ sessionId: target.id, status: 'attached' });
      if (target.id === coordinator.id)
        return refusal('invalid', 'A session cannot adopt itself.');
      if (!isCoordinatorCandidate(target))
        return refusal(
          'invalid',
          'Only a top-level session that is not part of a workflow or automation can be adopted.',
        );
      if (
        this.params.sessions
          .list()
          .some(session => session.parentId === target.id)
      )
        return refusal(
          'invalid',
          'A session that has its own child sessions cannot be adopted.',
        );
      if (target.parentRequest)
        return target.parentRequest.parentId === coordinator.id
          ? success({
              sessionId: target.id,
              status: 'awaiting-operator',
              requestId: target.parentRequest.id,
            })
          : refusal(
              'busy',
              'Another session already asked to adopt this session.',
            );
      const requestId = derivedId(actionId, 'parent');
      this.params.sessions.requestParent(target.id, {
        id: requestId,
        parentId: coordinator.id,
        parentTitle: coordinator.title.slice(0, 100),
        requestedAt: new Date().toISOString(),
      });
      return success({
        sessionId: target.id,
        status: 'awaiting-operator',
        requestId,
      });
    },
    session_stop: ({ coordinator, input }) => {
      const child = this.child(coordinator, input.sessionId);
      if (
        !child.runId ||
        (child.status !== 'running' && child.status !== 'stopping')
      )
        return success({
          sessionId: child.id,
          stopped: false,
          status: child.status,
        });
      const stopped = this.params.sessions.stop({
        sessionId: child.id,
        runId: child.runId,
      });
      return success({
        sessionId: child.id,
        stopped: true,
        status: stopped.status,
      });
    },
    events_wait: async ({ coordinator, input, signal }) => {
      this.params.sessions.recordCoordinatorWait(
        coordinator.id,
        coordinator.runId!,
        input.cursor,
        this.children(coordinator).filter(
          child =>
            child.status === 'running' ||
            child.status === 'stopping' ||
            child.queue.length,
        ),
      );
      try {
        const deadline = Date.now() + input.timeoutSeconds * 1000;
        for (;;) {
          const page = this.params.store.events(coordinator.id, input.cursor);
          if (page.events.length)
            return success({
              events: page.events,
              cursor: page.events.at(-1)!.seq,
              more: page.more,
            });
          const remaining = deadline - Date.now();
          if (remaining <= 0 || signal.aborted || this.params.signal.aborted)
            return success({
              events: [],
              cursor: input.cursor,
              timedOut: true,
            });
          await this.wait(coordinator.id, remaining, signal);
        }
      } finally {
        if (!signal.aborted && !this.params.signal.aborted)
          this.params.sessions.clearCoordinatorWait(
            coordinator.id,
            coordinator.runId!,
          );
      }
    },
    session_answer: ({ coordinator, input, actionId }) => {
      const child = this.steerableChild(coordinator, input.sessionId);
      const question = pendingStageQuestion(child);
      if (!question)
        return refusal(
          'invalid',
          'This session has no question waiting for an answer.',
        );
      if (question.question.kind === 'product')
        return refusal(
          'human-only',
          'Product questions belong to the computer owner. Wait for their answer with events_wait.',
        );
      const decisionId = derivedId(actionId, 'answer');
      const answered = this.params.sessions.answerStageQuestion(
        {
          sessionId: child.id,
          questionId: question.id,
          decisionId,
          ...(input.option ? { option: input.option } : {}),
          ...(input.text ? { text: input.text } : {}),
          via: 'desktop',
        },
        coordinatorActor(coordinator.id),
      );
      const messageId = decisionMessageId(decisionId);
      return success({
        sessionId: child.id,
        questionId: question.id,
        messageId,
        ...this.delivery(answered, messageId),
      });
    },
  };
}
