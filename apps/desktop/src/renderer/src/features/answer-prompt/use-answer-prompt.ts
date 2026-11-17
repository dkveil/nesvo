import { useRef, useState } from 'react';
import type {
  AnswerPromptInput,
  DesktopSession,
  PromptAnswer,
} from '@nesvo/contracts';
import {
  errorDetail,
  isAnswerable,
  type Session,
  type SessionPrompt,
} from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';

type Options = {
  submit: (input: AnswerPromptInput, hostId: string) => Promise<DesktopSession>;
  onAnswered: (session: DesktopSession) => void;
  onFailure: (hostId: string) => Promise<unknown>;
};

export const promptKey = (session: Session, prompt: SessionPrompt) =>
  `${entityKey(session)}/${prompt.runId}/${prompt.id}`;

export const useAnswerPrompt = ({ submit, onAnswered, onFailure }: Options) => {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requests = useRef(new Set<string>());
  const clearError = (key: string) =>
    setErrors(previous => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  const answer = async (
    session: Session,
    prompt: SessionPrompt,
    value: PromptAnswer,
  ) => {
    if (!isAnswerable(session, prompt)) return;
    const key = promptKey(session, prompt);
    if (requests.current.has(key)) return;
    requests.current.add(key);
    setPending(previous => ({ ...previous, [key]: true }));
    clearError(key);
    try {
      onAnswered(
        await submit(
          {
            sessionId: session.id,
            runId: prompt.runId,
            promptId: prompt.id,
            answer: value,
          },
          session.hostId,
        ),
      );
    } catch (failure) {
      setErrors(previous => ({
        ...previous,
        [key]: `Could not send the answer. ${errorDetail(failure)}`,
      }));
      try {
        await onFailure(session.hostId);
      } catch (recoveryFailure) {
        setErrors(previous => ({
          ...previous,
          [key]: `${previous[key] ?? ''} Could not refresh the conversation. ${errorDetail(recoveryFailure)}`,
        }));
      }
    } finally {
      requests.current.delete(key);
      setPending(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };
  return {
    answer,
    isSending: (session: Session, prompt: SessionPrompt) =>
      !!pending[promptKey(session, prompt)],
    errorOf: (session: Session, prompt: SessionPrompt) =>
      errors[promptKey(session, prompt)] ?? '',
  };
};

export type AnswerPromptController = ReturnType<typeof useAnswerPrompt>;
