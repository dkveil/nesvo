import { useState, type FormEvent, type ReactNode } from 'react';
import type { PlanAcceptMode } from '@nesvo/contracts';
import { cn } from 'cn';
import {
  modeLabel,
  type Provider,
  type SessionPrompt,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import {
  acceptNote,
  noAcceptModeNote,
  planHeading,
  planOutcome,
} from './prompt-text';

const PLAN_MAX_LINES = 14;
const PLAN_MAX_CHARACTERS = 1400;
const FEEDBACK_MAX_LENGTH = 8000;

const isLongPlan = (plan: string) =>
  plan.length > PLAN_MAX_CHARACTERS || plan.split('\n').length > PLAN_MAX_LINES;

type PlanBodyProps = {
  plan: string;
  renderPlan: (plan: string) => ReactNode;
};

export const PlanBody = ({ plan, renderPlan }: PlanBodyProps) => {
  const [expanded, setExpanded] = useState(false);
  const body = plan || 'The agent returned an empty plan.';
  const long = isLongPlan(body);
  const clamped = long && !expanded;
  return (
    <div className="min-w-0 space-y-1">
      <div
        className={cn(
          'relative rounded-lg border bg-background/60 p-3',
          clamped && 'max-h-84 overflow-hidden',
        )}
      >
        {renderPlan(body)}
        {clamped && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-lg bg-linear-to-t from-background to-transparent"
          />
        )}
      </div>
      {long && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? 'Show less' : 'Show full plan'}
        </Button>
      )}
    </div>
  );
};

type AcceptProps = {
  provider: Provider;
  modes: PlanAcceptMode[];
  disabled: boolean;
  compact?: boolean;
  onAccept: (mode: PlanAcceptMode) => void;
};

export const PlanAcceptButtons = ({
  provider,
  modes,
  disabled,
  compact = false,
  onAccept,
}: AcceptProps) => (
  <>
    {modes.map(mode => (
      <Button
        key={mode}
        type="button"
        size="sm"
        variant={
          mode === 'accept-edits'
            ? compact
              ? 'secondary'
              : 'default'
            : 'outline'
        }
        className={cn(compact && 'h-7 px-2.5 text-[13px] font-normal')}
        disabled={disabled}
        onClick={() => onAccept(mode)}
      >
        Accept and continue in {modeLabel(provider, mode)}
      </Button>
    ))}
  </>
);

type FeedbackProps = {
  disabled: boolean;
  className?: string;
  onRevise: (feedback: string) => void;
};

export const PlanFeedbackForm = ({
  disabled,
  className,
  onRevise,
}: FeedbackProps) => {
  const [feedback, setFeedback] = useState('');
  const trimmed = feedback.trim();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!disabled && trimmed) onRevise(trimmed);
  };
  return (
    <form className={cn('space-y-2', className)} onSubmit={submit}>
      <Textarea
        aria-label="Feedback"
        placeholder="What should the plan change?"
        maxLength={FEEDBACK_MAX_LENGTH}
        value={feedback}
        disabled={disabled}
        onChange={event => setFeedback(event.target.value)}
        onKeyDown={event => {
          if (
            event.key === 'Enter' &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        className="min-h-14 text-[13px]"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={disabled || !trimmed}
      >
        Keep planning
      </Button>
    </form>
  );
};

type Props = {
  prompt: SessionPrompt;
  provider: Provider;
  acceptModes: PlanAcceptMode[];
  acceptBlockedReason: string;
  enabled: boolean;
  inactiveReason: string;
  sending: boolean;
  error: string;
  renderPlan: (plan: string) => ReactNode;
  className?: string;
  onAccept: (mode: PlanAcceptMode) => void;
  onRevise: (feedback: string) => void;
};

export const PlanCard = ({
  prompt,
  provider,
  acceptModes,
  acceptBlockedReason,
  enabled,
  inactiveReason,
  sending,
  error,
  renderPlan,
  className,
  onAccept,
  onRevise,
}: Props) => {
  const pending = prompt.status === 'pending';
  const disabled = !enabled || sending;
  const offered = acceptBlockedReason ? [] : acceptModes;
  return (
    <section
      role="group"
      aria-label="Plan from the agent"
      id={`prompt-${prompt.id}`}
      data-prompt-id={prompt.id}
      data-prompt-status={prompt.status}
      data-plan-round={prompt.planRound}
      className={cn(
        'space-y-3 rounded-xl border bg-card/70 p-4',
        !pending && 'space-y-2 bg-transparent',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-sm font-medium">{planHeading(prompt)}</h3>
        {!pending && (
          <p className="text-xs text-muted-foreground">
            {planOutcome(prompt, provider)}
          </p>
        )}
      </div>
      <PlanBody
        key={`${prompt.id}/${prompt.status}`}
        plan={prompt.plan ?? ''}
        renderPlan={renderPlan}
      />
      {prompt.status === 'revised' && prompt.decision?.feedback && (
        <p className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
          Feedback: {prompt.decision.feedback}
        </p>
      )}
      {prompt.status === 'interrupted' && (
        <p role="note" className="text-xs text-muted-foreground">
          The run ended before a decision was sent.
        </p>
      )}
      {pending && (
        <>
          {offered.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-2">
                <PlanAcceptButtons
                  provider={provider}
                  modes={offered}
                  disabled={disabled}
                  onAccept={onAccept}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {acceptNote(provider, offered)}
              </p>
            </div>
          )}
          {offered.length === 0 && (
            <p role="note" className="text-xs text-muted-foreground">
              {acceptBlockedReason || noAcceptModeNote}
            </p>
          )}
          <PlanFeedbackForm disabled={disabled} onRevise={onRevise} />
          {(sending || !enabled) && (
            <p role="status" className="text-xs text-muted-foreground">
              {sending ? 'Sending decision…' : inactiveReason}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
};
