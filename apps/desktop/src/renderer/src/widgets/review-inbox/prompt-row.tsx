import { useState, type ReactNode } from 'react';
import type { PromptAnswer, SessionMode } from '@nesvo/contracts';
import {
  directoryLabel,
  type Session,
  type SessionPrompt,
} from '@/entities/session';
import {
  acceptNote,
  noAcceptModeNote,
  PlanAcceptButtons,
  PlanBody,
  PlanFeedbackForm,
  planAcceptBlockedReason,
  planAcceptModes,
  planHeading,
  QuestionCard,
} from '@/features/answer-prompt';
import { Button } from '@/shared/ui/button';
import { MessageBody } from '@/widgets/conversation/message-body';

type Props = {
  session: Session;
  prompt: SessionPrompt;
  sessionLink: ReactNode;
  hostLabel: string;
  modes: SessionMode[];
  enabled: boolean;
  inactiveReason: string;
  sending: boolean;
  error: string;
  className?: string;
  onAnswer: (answer: PromptAnswer) => void;
};

const renderPlan = (plan: string) => (
  <MessageBody body={plan} className="text-[13px] leading-6" />
);

const questionPreview = (prompt: SessionPrompt) => {
  const [first, ...rest] = prompt.questions;
  if (!first) return 'Question from the agent';
  return rest.length > 0
    ? `${first.question} (+${rest.length} more)`
    : first.question;
};

export const PromptRow = ({
  session,
  prompt,
  sessionLink,
  hostLabel,
  modes,
  enabled,
  inactiveReason,
  sending,
  error,
  className,
  onAnswer,
}: Props) => {
  const [revising, setRevising] = useState(false);
  const disabled = !enabled || sending;
  const blockedReason = planAcceptBlockedReason(session);
  const offered = blockedReason ? [] : planAcceptModes(modes);
  const plan = prompt.kind === 'plan';
  return (
    <article
      aria-label={`${plan ? 'Plan' : 'Question'} from the agent: ${session.title}`}
      data-prompt-id={prompt.id}
      data-host-id={session.hostId}
      className={className}
    >
      <div className="min-w-0 space-y-1">
        {sessionLink}
        {hostLabel && (
          <p className="text-2xs text-muted-foreground">{hostLabel}</p>
        )}
        <p
          className="line-clamp-2 text-[13px] leading-5 [overflow-wrap:anywhere]"
          title={plan ? undefined : questionPreview(prompt)}
        >
          {plan ? 'Plan ready' : questionPreview(prompt)}
        </p>
        <p className="flex items-center gap-2 text-2xs leading-4 text-muted-foreground">
          <span className="shrink-0">
            {plan ? planHeading(prompt) : 'Question'} · {session.provider}
          </span>
          <span>·</span>
          <span
            className="truncate"
            title={session.directory}
            aria-label={`Working directory: ${session.directory}`}
          >
            {directoryLabel(session.directory)}
          </span>
        </p>
        {plan && <PlanBody plan={prompt.plan ?? ''} renderPlan={renderPlan} />}
      </div>
      {plan && (
        <div className="flex flex-wrap items-center gap-1.5 self-center">
          <PlanAcceptButtons
            compact
            provider={session.provider}
            modes={offered}
            disabled={disabled}
            onAccept={mode =>
              onAnswer({ kind: 'plan', decision: 'accept', mode })
            }
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[13px] font-normal"
            aria-expanded={revising}
            disabled={disabled}
            onClick={() => setRevising(value => !value)}
          >
            Keep planning
          </Button>
        </div>
      )}
      {plan && (
        <p className="col-span-full text-2xs text-muted-foreground">
          {offered.length > 0
            ? acceptNote(session.provider, offered)
            : blockedReason || noAcceptModeNote}
        </p>
      )}
      {plan && revising && (
        <PlanFeedbackForm
          className="col-span-full"
          disabled={disabled}
          onRevise={feedback =>
            onAnswer({ kind: 'plan', decision: 'revise', feedback })
          }
        />
      )}
      {!plan && (
        <QuestionCard
          compact
          className="col-span-full"
          prompt={prompt}
          enabled={enabled}
          inactiveReason={inactiveReason}
          sending={sending}
          error=""
          onSubmit={answers => onAnswer({ kind: 'question', answers })}
        />
      )}
      {plan && (sending || !enabled) && (
        <p
          role="status"
          className="col-span-full text-2xs text-muted-foreground"
        >
          {sending ? 'Sending decision…' : inactiveReason}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="col-span-full text-xs text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
    </article>
  );
};
