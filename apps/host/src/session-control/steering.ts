import { createHash } from 'node:crypto';
import {
  sessionSteerResultSchema,
  type DecideSteeringInput,
  type DecisionRoute,
  type Session,
  type SessionControlRefusalCode,
  type SessionSteerInput,
  type SessionSteerResult,
} from '@nesvo/contracts';
import type { SessionService } from '../sessions/service';
import { SessionError } from '../sessions/session-error';
import { derivedUuid } from '../sessions/stages';
import type { SessionControlStore } from './store';

export class SteeringRefusal extends SessionError {
  constructor(
    readonly refusal: SessionControlRefusalCode,
    message: string,
  ) {
    super(refusal === 'busy' ? 'busy' : 'invalid-request', message);
  }
}

type StoredSteering =
  SessionSteerResult | { code: SessionControlRefusalCode; message: string };

type SteeringPorts = {
  sessions: SessionService;
  store: SessionControlStore;
  route: (session: Session) => DecisionRoute;
};

export class ChildSteering {
  constructor(private readonly ports: SteeringPorts) {}

  private receipt(id: string, fingerprint: string): StoredSteering | undefined {
    const row = this.ports.store.steering(id);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint)
      throw new SteeringRefusal(
        'invalid',
        'This action already belongs to a different steering request.',
      );
    return JSON.parse(String(row.document)) as StoredSteering;
  }

  private result(receipt: StoredSteering): SessionSteerResult {
    if ('code' in receipt)
      throw new SteeringRefusal(receipt.code, receipt.message);
    return sessionSteerResultSchema.parse(receipt);
  }

  private task(child: Session) {
    const parent = child.parentId
      ? this.ports.sessions.snapshot(child.parentId)
      : undefined;
    const proposal = parent?.delegations.find(
      item =>
        item.childSessionId === child.id &&
        item.childRunId === child.runId &&
        item.status === 'running',
    );
    return proposal
      ? this.hash([
          proposal.id,
          proposal.task,
          proposal.scope,
          child.parentRunId,
        ])
      : null;
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  async steer(
    input: SessionSteerInput,
    actionId: string,
    sender: Session | null,
    signal: AbortSignal,
  ) {
    const { store, sessions } = this.ports;
    const key = sender ? actionId : 'operator:' + actionId;
    const fingerprint = this.hash([sender?.id ?? null, input]);
    const identity = {
      actionId,
      messageId: derivedUuid(actionId, 'steer'),
      targetRunId: input.expectedRunId,
    };
    const child = sessions.snapshot(input.sessionId);
    if (!child || !child.parentId || (sender && child.parentId !== sender.id))
      throw new SteeringRefusal(
        'not-in-subtree',
        'Choose a direct child session.',
      );
    const previous = this.receipt(key, fingerprint);
    if (previous) return this.result(previous);
    if (child.runId !== input.expectedRunId)
      throw new SteeringRefusal(
        'stale-run',
        'Read the current child run before sending feedback.',
      );
    if (sender && child.role === 'worker') {
      const task = this.task(child);
      if (!task)
        throw new SteeringRefusal(
          'stale-run',
          'The approved worker task is no longer running.',
        );
      const requestId = derivedUuid(actionId, 'request');
      const receipt = {
        ...identity,
        status: 'awaiting-owner',
        requestId,
      } as const;
      sessions.rememberSteeringRequest(
        child.id,
        input.expectedRunId,
        {
          id: requestId,
          coordinatorId: sender.id,
          runId: input.expectedRunId,
          text: input.text,
          createdAt: new Date().toISOString(),
          route: this.ports.route(child),
        },
        () => store.saveSteering(key, fingerprint, receipt, { input, task }),
      );
      return receipt;
    }
    return this.deliver(
      input,
      identity,
      key,
      fingerprint,
      sender?.id ?? null,
      signal,
    );
  }

  async decide(input: DecideSteeringInput, signal: AbortSignal) {
    const { sessions, store } = this.ports;
    const key = 'decision:' + input.actionId;
    const fingerprint = this.hash(input);
    const previous = this.receipt(key, fingerprint);
    if (previous) return this.result(previous);
    const child = sessions.snapshot(input.sessionId);
    const active = child?.steeringRequests?.find(
      item => item.id === input.requestId,
    );
    const request = store.steeringRequest(input.requestId);
    const currentTask = child ? this.task(child) : null;
    if (
      !child ||
      !active ||
      !request ||
      child.status !== 'running' ||
      child.runId !== input.expectedRunId ||
      active.runId !== input.expectedRunId ||
      !currentTask ||
      request.task !== currentTask
    )
      throw new SteeringRefusal(
        'stale-decision',
        'This feedback request is no longer waiting on the original task and run.',
      );
    const identity = {
      actionId: input.actionId,
      messageId: request.messageId,
      targetRunId: input.expectedRunId,
    };
    if (input.decision === 'decline') {
      const receipt = { ...identity, status: 'declined' } as const;
      sessions.removeSteeringRequest(child.id, input.requestId, () =>
        store.saveSteering(key, fingerprint, receipt),
      );
      return receipt;
    }
    return this.deliver(
      request.input,
      identity,
      key,
      fingerprint,
      active.coordinatorId,
      signal,
      input.requestId,
    );
  }

  private async deliver(
    input: SessionSteerInput,
    identity: Pick<
      SessionSteerResult,
      'actionId' | 'messageId' | 'targetRunId'
    >,
    key: string,
    fingerprint: string,
    senderId: string | null,
    signal: AbortSignal,
    requestId?: string,
  ) {
    const { sessions, store } = this.ports;
    const save = (result: StoredSteering) =>
      store.saveSteering(key, fingerprint, result);
    return sessions.withSteering(
      input.sessionId,
      input.expectedRunId,
      async (child, steer) => {
        if (signal.aborted)
          throw new SteeringRefusal(
            'stale-run',
            'The original sending turn ended.',
          );
        const unconfirmed = {
          ...identity,
          status: 'delivery-unknown',
        } as const;
        if (requestId)
          sessions.removeSteeringRequest(child.id, requestId, () =>
            save(unconfirmed),
          );
        else save(unconfirmed);
        const delivery = await steer(input.text, signal);
        if (delivery.status === 'steered') {
          const receipt = { ...identity, ...delivery };
          try {
            sessions.recordSteeredMessage(
              child,
              identity.messageId,
              senderId,
              input.text,
              delivery.deliveredAt,
              () => save(receipt),
            );
            return receipt;
          } catch {
            return unconfirmed;
          }
        }
        if (delivery.status === 'delivery-unknown') return unconfirmed;
        if (
          delivery.status === 'unsupported' &&
          input.fallback === 'queue' &&
          !signal.aborted
        ) {
          try {
            const position = child.queue.length + 1;
            const receipt = {
              ...identity,
              status: 'queued',
              position,
              reason: delivery.reason,
            } as const;
            sessions.queueSteeredMessage(
              child,
              input.expectedRunId,
              identity.messageId,
              input.text,
              () => save(receipt),
            );
            return receipt;
          } catch (error) {
            const code =
              child.runId !== input.expectedRunId || child.status !== 'running'
                ? 'stale-run'
                : 'busy';
            const message =
              'The child cannot queue this feedback for its current run. Refresh its state before sending.';
            if (!(error instanceof SessionError)) throw error;
            save({ code, message });
            throw new SteeringRefusal(code, message);
          }
        }
        const code =
          delivery.status === 'unsupported' ? 'unsupported' : delivery.status;
        const message =
          code === 'unsupported' && delivery.status === 'unsupported'
            ? delivery.reason
            : code === 'busy'
              ? 'The child is still starting or needs a decision. Try again when the child is ready.'
              : 'The original child run has ended. Read its new state before sending.';
        save({ code, message });
        throw new SteeringRefusal(code, message);
      },
    );
  }
}
