import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  createSessionSchema,
  isProviderSessionMode,
  isSessionControlToolName,
  sessionControlLimits,
  sessionControlTools,
  type CoordinatorPolicy,
  type DecideSessionParentInput,
  type Session,
  type SessionControlChild,
  type SessionControlRefusalCode,
  type SessionControlToolInput,
  type SessionControlToolName,
  type SessionMode,
} from '@nesvo/contracts';
import {
  isCoordinatorCandidate,
  type RunFinished,
  type SessionService,
} from '../sessions/service';
import { SessionError } from '../sessions/session-error';
import type { SessionControlStore } from './store';
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

const PLAN_TEXT_LIMIT = 12_000;
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
  if (error instanceof ChildRefusal) return refusal(error.refusal, error.message);
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

const derivedId = (actionId: string, purpose: string): string => {
  const hex = createHash('sha256')
    .update(`${actionId}\n${purpose}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(
    (parseInt(hex[16] ?? '0', 16) & 0x3) |
    0x8
  ).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const planPrompt = (prompt: string) =>
  `${prompt}\n\nFirst produce a plan only: list the files you would change and the steps, do not change anything yet.`;

const approvedPlanPrompt = (plan: string, resolutions?: string) =>
  `The plan was accepted. Carry it out now.\n\nApproved plan:\n${plan}${resolutions ? `\n\nResolutions from the coordinator:\n${resolutions}` : ''}`;

const correctedPlanPrompt = (correction: string) =>
  `Revise the plan with this correction from the coordinator and return the full plan again. Do not change anything yet.\n\nCorrection:\n${correction}`;

const lastReply = (session: Session) =>
  session.messages.findLast(message => message.author === 'agent');

const allowedModes = (policy: CoordinatorPolicy) =>
  policy.childModes.length ? policy.childModes.join(', ') : 'no modes';

export class SessionControl {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly inFlight = new Map<string, Promise<SessionControlReply>>();
  private readonly seenApprovals = new Set<string>();

  constructor(private readonly params: SessionControlParams) {}

  bridge(): SessionControlBridge {
    return {
      available: session =>
        this.params.store.policy().enabled && isCoordinatorCandidate(session),
      call: (caller, call, signal) => this.call(caller, call, signal),
    };
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
    if (!isSessionControlToolName(call.tool))
      return refusal('unsupported', `Nesvo has no tool named ${call.tool}.`);
    const tool = call.tool;
    if (!sessionControlTools[tool].mutation)
      return this.execute(caller, tool, call.input, '', signal);
    const actionId = createHash('sha256')
      .update(`${caller.sessionId}\n${call.callId}`)
      .digest('hex');
    const stored = this.params.store.action(actionId);
    if (stored) return JSON.parse(stored.result) as SessionControlReply;
    const running = this.inFlight.get(actionId);
    if (running) return running;
    const execution = this.execute(caller, tool, call.input, actionId, signal)
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
    if (record.planStatus === 'planning' && finished.status === 'completed') {
      const plan = (lastReply(child)?.body ?? '').slice(0, PLAN_TEXT_LIMIT);
      this.params.store.saveChild({
        ...record,
        planStatus: 'plan-ready',
        plan,
      });
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
    if (!policy.enabled)
      return refusal(
        'disabled',
        'Session control is turned off in Settings on this computer.',
      );
    const coordinator = this.params.sessions.snapshot(caller.sessionId);
    if (
      !coordinator ||
      coordinator.runId !== caller.runId ||
      !isCoordinatorCandidate(coordinator)
    )
      return refusal(
        'unsupported',
        'Only the running turn of a top-level session can coordinate sessions.',
      );
    const parsed = sessionControlTools[tool].input.safeParse(input);
    if (!parsed.success)
      return refusal(
        'invalid',
        parsed.error.issues
          .slice(0, 5)
          .map(
            issue =>
              `${issue.path.join('.') || 'input'}: ${issue.message}`,
          )
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

  private child(coordinator: Session, sessionId: string): Session {
    const child = this.params.sessions.snapshot(sessionId);
    if (
      !child ||
      child.parentId !== coordinator.id ||
      child.role === 'worker'
    )
      throw new ChildRefusal(
        'not-in-subtree',
        'This session is not one of your child sessions.',
      );
    return child;
  }

  private children(coordinator: Session): Session[] {
    return this.params.sessions
      .list()
      .filter(
        session =>
          session.parentId === coordinator.id && session.role !== 'worker',
      )
      .map(session => this.params.sessions.snapshot(session.id))
      .filter((session): session is Session => !!session);
  }

  private summary(child: Session): SessionControlChild {
    const window = this.params.sessions.window(child, 1);
    const plan = this.params.store.child(child.id)?.planStatus;
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
          : child.pendingApprovals.length
            ? 'approval'
            : window.waitingFor
              ? 'folder'
              : child.queue.length && !running
                ? 'queue'
                : null,
      needsDecision: plan === 'plan-ready' || child.pendingApprovals.length > 0,
      queued: child.queue.length,
      lastActivityAt: child.updatedAt,
      pullRequest: child.pullRequest,
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
      if (input.worktree && !policy.worktrees)
        return refusal(
          'forbidden-by-policy',
          'The coordinator policy does not allow creating worktrees.',
        );
      const directory = isAbsolute(input.directory)
        ? input.directory
        : resolve(coordinator.directory, input.directory);
      const create = createSessionSchema.safeParse({
        requestId: derivedId(actionId, 'create'),
        title: input.title,
        provider,
        model,
        mode: input.planFirst ? 'read-only' : input.mode,
        directory,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.worktree
          ? {
              isolation: {
                kind: 'worktree',
                ...(input.worktree.branch
                  ? { branch: input.worktree.branch }
                  : {}),
              },
            }
          : {}),
        ...((input.groupId ?? coordinator.groupId)
          ? { groupId: input.groupId ?? coordinator.groupId }
          : {}),
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
      );
      if (!this.params.store.child(child.id))
        this.params.store.saveChild({
          sessionId: child.id,
          parentId: coordinator.id,
          planStatus: input.planFirst ? 'planning' : null,
          planRound: 0,
          targetMode: input.planFirst ? input.mode : null,
          plan: null,
        });
      const messageId = derivedId(actionId, 'message');
      this.params.sessions.queue({
        sessionId: child.id,
        messageId,
        text: input.planFirst ? planPrompt(input.prompt) : input.prompt,
      });
      return success({
        sessionId: child.id,
        messageId,
        ...this.delivery(child, messageId),
        planFirst: input.planFirst,
      });
    },
    session_send: ({ coordinator, input, actionId, policy }) => {
      const child = this.child(coordinator, input.sessionId);
      const refused =
        this.refuseModel(policy, input.model) ??
        this.refuseMode(policy, input.mode);
      if (refused) return refused;
      const messageId = derivedId(actionId, 'message');
      this.params.sessions.queue({
        sessionId: child.id,
        messageId,
        text: input.text,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.mode ? { mode: input.mode } : {}),
      });
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
      const record = this.params.store.child(child.id);
      if (!record || record.planStatus !== 'plan-ready')
        return refusal(
          'invalid',
          'This session has no plan waiting for a decision.',
        );
      const messageId = derivedId(actionId, 'message');
      if (input.decision === 'decline') {
        this.params.store.saveChild({ ...record, planStatus: 'declined' });
        return success({ sessionId: child.id, decision: 'decline' });
      }
      if (input.decision === 'correct') {
        if (record.planRound + 1 >= sessionControlLimits.planRounds)
          return refusal(
            'invalid',
            `A plan can be corrected at most ${sessionControlLimits.planRounds - 1} times. Accept or decline it.`,
          );
        this.params.sessions.queue({
          sessionId: child.id,
          messageId,
          text: correctedPlanPrompt(input.text ?? ''),
          mode: 'read-only',
        });
        this.params.store.saveChild({
          ...record,
          planStatus: 'planning',
          planRound: record.planRound + 1,
        });
        return success({
          sessionId: child.id,
          decision: 'correct',
          messageId,
          ...this.delivery(child, messageId),
        });
      }
      const mode = record.targetMode ?? child.mode;
      const refused = this.refuseMode(policy, mode);
      if (refused) return refused;
      this.params.sessions.queue({
        sessionId: child.id,
        messageId,
        text: approvedPlanPrompt(record.plan ?? '', input.text),
        mode,
      });
      this.params.store.saveChild({ ...record, planStatus: 'accepted' });
      return success({
        sessionId: child.id,
        decision: 'accept',
        mode,
        messageId,
        ...this.delivery(child, messageId),
      });
    },
    session_set_model: ({ coordinator, input, policy }) => {
      const child = this.child(coordinator, input.sessionId);
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
      const child = this.child(coordinator, input.sessionId);
      const updated = this.params.sessions.changeSelection(child.id, {
        effort: input.effort,
      });
      return success({
        sessionId: child.id,
        effort: updated.effort,
        appliesFrom: 'next-turn',
      });
    },
    session_set_mode: ({ coordinator, input, policy }) => {
      const child = this.child(coordinator, input.sessionId);
      const refused = this.refuseMode(policy, input.mode);
      if (refused) return refused;
      if (!isProviderSessionMode(child.provider, input.mode))
        return refusal(
          'invalid',
          `${child.provider} does not support the ${input.mode} permission mode.`,
        );
      const record = this.params.store.child(child.id);
      if (
        record?.planStatus === 'planning' ||
        record?.planStatus === 'plan-ready'
      ) {
        this.params.store.saveChild({ ...record, targetMode: input.mode });
        return success({
          sessionId: child.id,
          mode: input.mode,
          appliesFrom: 'accepted-plan',
        });
      }
      const updated = this.params.sessions.changeSelection(child.id, {
        mode: input.mode,
      });
      return success({
        sessionId: child.id,
        mode: updated.mode,
        appliesFrom: 'next-turn',
      });
    },
    session_set_parent: ({ coordinator, input, actionId }) => {
      const target = this.params.sessions.snapshot(input.sessionId);
      if (!target)
        return refusal('not-found', 'This session does not exist.');
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
          return success({ events: [], cursor: input.cursor, timedOut: true });
        await this.wait(coordinator.id, remaining, signal);
      }
    },
  };
}
