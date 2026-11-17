import type { ReactNode } from 'react';
import type { SessionMode } from '@nesvo/contracts';
import { isAnswerable, type Session } from '@/entities/session';
import { PlanCard } from './plan-card';
import {
  planAcceptBlockedReason,
  planAcceptModes,
  promptsOfRun,
} from './prompt-text';
import { QuestionCard } from './question-card';
import type { AnswerPromptController } from './use-answer-prompt';

type Props = {
  session: Session;
  runId: string;
  controller: AnswerPromptController;
  enabled: boolean;
  inactiveReason: string;
  modes: SessionMode[];
  renderPlan: (plan: string) => ReactNode;
};

export const PromptCards = ({
  session,
  runId,
  controller,
  enabled,
  inactiveReason,
  modes,
  renderPlan,
}: Props) => {
  const prompts = promptsOfRun(session, runId);
  if (prompts.length === 0) return null;
  return (
    <div className="space-y-3">
      {prompts.map(prompt => {
        const answerable = isAnswerable(session, prompt);
        const common = {
          prompt,
          enabled: enabled && answerable,
          inactiveReason: answerable
            ? inactiveReason
            : 'This run is no longer active.',
          sending: controller.isSending(session, prompt),
          error: controller.errorOf(session, prompt),
        };
        return prompt.kind === 'question' ? (
          <QuestionCard
            key={prompt.id}
            {...common}
            onSubmit={answers =>
              void controller.answer(session, prompt, {
                kind: 'question',
                answers,
              })
            }
          />
        ) : (
          <PlanCard
            key={prompt.id}
            {...common}
            provider={session.provider}
            acceptModes={planAcceptModes(modes)}
            acceptBlockedReason={planAcceptBlockedReason(session)}
            renderPlan={renderPlan}
            onAccept={mode =>
              void controller.answer(session, prompt, {
                kind: 'plan',
                decision: 'accept',
                mode,
              })
            }
            onRevise={feedback =>
              void controller.answer(session, prompt, {
                kind: 'plan',
                decision: 'revise',
                feedback,
              })
            }
          />
        );
      })}
    </div>
  );
};
