import { useState } from 'react';
import {
  pendingStageQuestion,
  type DesktopApi,
  type SessionMode,
  type StageActor,
} from '@nesvo/contracts';
import { errorDetail, type Session } from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';

export type PlanChoice = {
  decision: 'accept' | 'correct' | 'decline';
  mode?: SessionMode;
  text?: string;
};

export type QuestionChoice = { option?: string; text?: string };

export type StageActions = {
  isEnabled: (session: Session) => boolean;
  modesFor: (session: Session) => SessionMode[];
  pending: Record<string, boolean>;
  errors: Record<string, string>;
  onPlan: (session: Session, choice: PlanChoice) => void;
  onAnswer: (session: Session, choice: QuestionChoice) => void;
};

type StageApi = Pick<DesktopApi, 'decideSessionPlan' | 'answerSessionQuestion'>;

type Params = {
  api: (hostId: string) => StageApi;
  merge: (sessions: Session[]) => void;
  isEnabled: (session: Session) => boolean;
  modesFor: (session: Session) => SessionMode[];
};

export const stageKey = (session: Session, id: string) =>
  `${entityKey(session)}/${id}`;

export const actorText = (actor: StageActor) =>
  actor.kind === 'coordinator'
    ? 'the coordinator'
    : actor.via === 'mobile'
      ? 'you on the phone'
      : 'you';

export function useStageDecisions({
  api,
  merge,
  isEnabled,
  modesFor,
}: Params): StageActions {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = async (key: string, action: () => Promise<Session>) => {
    if (pending[key]) return;
    setPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      merge([await action()]);
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `Could not send the decision. ${errorDetail(failure)}`,
      }));
    } finally {
      setPending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  return {
    isEnabled,
    modesFor,
    pending,
    errors,
    onPlan: (session, choice) => {
      const plan = session.plan;
      if (!plan || plan.status !== 'plan-ready') return;
      void run(stageKey(session, plan.id), () =>
        api(session.hostId).decideSessionPlan(
          {
            sessionId: session.id,
            planId: plan.id,
            decisionId: crypto.randomUUID(),
            ...choice,
          },
          session.hostId,
        ),
      );
    },
    onAnswer: (session, choice) => {
      const question = pendingStageQuestion(session);
      if (!question) return;
      void run(stageKey(session, question.id), () =>
        api(session.hostId).answerSessionQuestion(
          {
            sessionId: session.id,
            questionId: question.id,
            decisionId: crypto.randomUUID(),
            ...choice,
          },
          session.hostId,
        ),
      );
    },
  };
}
