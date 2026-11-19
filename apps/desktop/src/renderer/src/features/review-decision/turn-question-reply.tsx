import { useRef, useState } from 'react';
import type { TurnQuestion } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { StatusMessage } from '@/shared/ui/status-message';

export function TurnQuestionReply({
  questions,
  enabled,
  onReply,
}: {
  questions: TurnQuestion;
  enabled: boolean;
  onReply: (text: string, messageId: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ text: string; id: string } | null>(null);
  const disabled = !enabled || pending;
  const reply = async (text: string) => {
    if (disabled || !text.trim()) return;
    setPending(true);
    setError('');
    const submission =
      attempt.current?.text === text
        ? attempt.current
        : { text, id: crypto.randomUUID() };
    attempt.current = submission;
    try {
      await onReply(text, submission.id);
    } catch (reason) {
      setError(errorDetail(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="col-span-full min-w-0 space-y-1.5">
      {questions.map((question, index) => (
        <div key={index} className="space-y-1">
          <p
            className="line-clamp-2 whitespace-pre-line break-words text-ui"
            title={question.text}
          >
            {question.text}
          </p>
          {question.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {question.options.map(option => (
                <Button
                  key={option}
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  className="max-w-full"
                  onClick={() => {
                    if (questions.length === 1 && !question.multiple)
                      void reply(option);
                    else
                      setAnswer(current =>
                        current ? `${current}; ${option}` : option,
                      );
                  }}
                >
                  <span className="truncate">{option}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      ))}
      <form
        aria-label="Reply to question"
        className="flex max-w-md items-center gap-1.5"
        onSubmit={event => {
          event.preventDefault();
          void reply(answer.trim());
        }}
      >
        <Input
          aria-label="Reply"
          placeholder="Write a reply"
          value={answer}
          maxLength={32000}
          disabled={disabled}
          onChange={event => setAnswer(event.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={disabled || !answer.trim()}
        >
          Send reply
        </Button>
      </form>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </div>
  );
}
