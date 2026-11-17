import { useState, type FormEvent } from 'react';
import type { PromptQuestion } from '@nesvo/contracts';
import { cn } from 'cn';
import type { SessionPrompt } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';

type Choice = { labels: string[]; other: boolean; otherText: string };

type Props = {
  prompt: SessionPrompt;
  enabled: boolean;
  inactiveReason: string;
  sending: boolean;
  error: string;
  compact?: boolean;
  className?: string;
  onSubmit: (answers: Record<string, string>) => void;
};

const emptyChoice: Choice = { labels: [], other: false, otherText: '' };

const answerOf = (question: PromptQuestion, choice: Choice) => {
  const labels = question.options
    .map(option => option.label)
    .filter(label => choice.labels.includes(label));
  const other = choice.other ? choice.otherText.trim() : '';
  return [...labels, ...(other ? [other] : [])].join(', ');
};

const resolvedNotes: Partial<Record<SessionPrompt['status'], string>> = {
  interrupted: 'The run ended before an answer was sent.',
  declined: 'This question was closed without an answer.',
};

const statusTitles: Partial<Record<SessionPrompt['status'], string>> = {
  answered: 'Answered',
  interrupted: 'Not answered',
  declined: 'Declined',
};

const HeaderChip = ({ header }: { header: string }) =>
  header ? (
    <span className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-4 font-normal text-muted-foreground">
      {header}
    </span>
  ) : null;

const optionClass =
  'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors duration-100 hover:bg-accent has-checked:border-ring has-checked:bg-accent/60 has-disabled:cursor-not-allowed has-disabled:opacity-60';

const compactOptionClass =
  'inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1 transition-colors duration-100 hover:bg-accent has-checked:border-ring has-checked:bg-accent/60 has-disabled:cursor-not-allowed has-disabled:opacity-60';

export const QuestionCard = ({
  prompt,
  enabled,
  inactiveReason,
  sending,
  error,
  compact = false,
  className,
  onSubmit,
}: Props) => {
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const choiceAt = (index: number) => choices[index] ?? emptyChoice;
  const update = (index: number, change: (choice: Choice) => Choice) =>
    setChoices(previous => ({
      ...previous,
      [index]: change(previous[index] ?? emptyChoice),
    }));
  const answers = Object.fromEntries(
    prompt.questions.map((question, index) => [
      question.question,
      answerOf(question, choiceAt(index)),
    ]),
  );
  const complete =
    prompt.questions.length > 0 &&
    Object.values(answers).every(answer => answer.length > 0);
  const canSubmit = enabled && !sending && complete;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSubmit) onSubmit(answers);
  };
  const pending = prompt.status === 'pending';
  const frame = cn(
    'space-y-4',
    !compact && 'rounded-xl border bg-card/70 p-4',
    className,
  );
  if (!pending)
    return (
      <section
        role="group"
        aria-label="Question from the agent"
        id={compact ? undefined : `prompt-${prompt.id}`}
        data-prompt-id={prompt.id}
        data-prompt-status={prompt.status}
        className={cn('space-y-1.5', className)}
      >
        <p className="text-xs text-muted-foreground">
          {statusTitles[prompt.status] ?? 'Question'}
        </p>
        <dl className="space-y-2">
          {prompt.questions.map(question => (
            <div key={question.question} className="space-y-0.5">
              <dt className="flex items-center gap-2 text-[13px] leading-5 text-muted-foreground">
                <HeaderChip header={question.header} />
                <span className="[overflow-wrap:anywhere]">
                  {question.question}
                </span>
              </dt>
              {prompt.answers?.[question.question] && (
                <dd className="text-sm leading-6 [overflow-wrap:anywhere]">
                  {prompt.answers[question.question]}
                </dd>
              )}
            </div>
          ))}
        </dl>
        {resolvedNotes[prompt.status] && (
          <p role="note" className="text-xs text-muted-foreground">
            {resolvedNotes[prompt.status]}
          </p>
        )}
      </section>
    );
  const disabled = !enabled || sending;
  return (
    <section
      role="group"
      aria-label="Question from the agent"
      id={compact ? undefined : `prompt-${prompt.id}`}
      data-prompt-id={prompt.id}
      data-prompt-status={prompt.status}
      className={frame}
    >
      {!compact && (
        <p className="text-xs text-muted-foreground">
          {prompt.questions.length === 1
            ? 'The agent is waiting for your answer'
            : `The agent is waiting for ${prompt.questions.length} answers`}
        </p>
      )}
      <form className={compact ? 'space-y-3' : 'space-y-4'} onSubmit={submit}>
        {prompt.questions.map((question, index) => {
          const choice = choiceAt(index);
          const name = `${prompt.id}-${index}`;
          const type = question.multiSelect ? 'checkbox' : 'radio';
          const toggle = (label: string) =>
            update(index, current =>
              question.multiSelect
                ? {
                    ...current,
                    labels: current.labels.includes(label)
                      ? current.labels.filter(item => item !== label)
                      : [...current.labels, label],
                  }
                : { ...current, labels: [label], other: false },
            );
          const chooseOther = (other: boolean) =>
            update(index, current => ({
              ...current,
              other,
              labels: question.multiSelect ? current.labels : [],
            }));
          return (
            <div key={question.question} className="min-w-0 space-y-2">
              <p
                className={cn(
                  'flex items-start gap-2 font-medium',
                  compact ? 'text-[13px] leading-5' : 'text-sm leading-6',
                )}
              >
                <HeaderChip header={question.header} />
                <span className="[overflow-wrap:anywhere]">
                  {question.question}
                </span>
              </p>
              {question.multiSelect && !compact && (
                <p className="text-xs text-muted-foreground">
                  Choose one or more.
                </p>
              )}
              <div
                role={question.multiSelect ? 'group' : 'radiogroup'}
                aria-label={question.question}
                className={compact ? 'flex flex-wrap gap-1.5' : 'grid gap-1.5'}
              >
                {question.options.map((option, optionIndex) => {
                  const descriptionId = `${name}-option-${optionIndex}`;
                  return (
                    <label
                      key={option.label}
                      title={compact ? option.description : undefined}
                      className={compact ? compactOptionClass : optionClass}
                    >
                      <input
                        type={type}
                        name={name}
                        aria-label={option.label}
                        aria-describedby={
                          option.description ? descriptionId : undefined
                        }
                        checked={choice.labels.includes(option.label)}
                        disabled={disabled}
                        onChange={() => toggle(option.label)}
                        className={cn(
                          'size-3.5 shrink-0 accent-primary',
                          !compact && 'mt-1',
                        )}
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-[13px] leading-5 [overflow-wrap:anywhere]">
                          {option.label}
                        </span>
                        {option.description && (
                          <span
                            id={descriptionId}
                            className={cn(
                              'block text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]',
                              compact && 'sr-only',
                            )}
                          >
                            {option.description}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
                <label className={compact ? compactOptionClass : optionClass}>
                  <input
                    type={type}
                    name={name}
                    aria-label="Other"
                    checked={choice.other}
                    disabled={disabled}
                    onChange={() =>
                      chooseOther(question.multiSelect ? !choice.other : true)
                    }
                    className={cn(
                      'size-3.5 shrink-0 accent-primary',
                      !compact && 'mt-1',
                    )}
                  />
                  <span className="text-[13px] leading-5">Other</span>
                </label>
                {choice.other && (
                  <Input
                    autoFocus
                    aria-label="Other answer"
                    placeholder="Type your own answer"
                    maxLength={2000}
                    value={choice.otherText}
                    disabled={disabled}
                    onChange={event => {
                      const otherText = event.target.value;
                      update(index, current => ({
                        ...current,
                        otherText,
                      }));
                    }}
                    className={cn(
                      'h-8 text-[13px]',
                      compact && 'h-7 w-56 max-w-full',
                    )}
                  />
                )}
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {prompt.questions.length === 1 ? 'Send answer' : 'Send answers'}
          </Button>
          <p role="status" className="text-xs text-muted-foreground">
            {sending
              ? 'Sending answer…'
              : !enabled
                ? inactiveReason
                : complete
                  ? ''
                  : 'Answer every question to continue.'}
          </p>
        </div>
        {error && (
          <p
            role="alert"
            className="text-xs text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
      </form>
    </section>
  );
};
