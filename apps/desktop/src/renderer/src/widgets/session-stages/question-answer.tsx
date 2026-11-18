import { useState } from 'react';
import type { StageQuestionRecord } from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { stageKey, type StageActions } from './use-stage-decisions';

type Props = {
  session: Session;
  record: StageQuestionRecord;
  actions: StageActions;
  compact?: boolean;
};

const TEXT_LIMIT = 4000;

export function QuestionAnswer({
  session,
  record,
  actions,
  compact = false,
}: Props) {
  const [writing, setWriting] = useState(!compact);
  const [text, setText] = useState('');
  const key = stageKey(session, record.id);
  const deciding = !!actions.pending[key];
  const enabled = actions.isEnabled(session) && !deciding;
  const fullWidth = compact && 'col-span-full';
  return (
    <div className={compact ? 'contents' : 'space-y-2'}>
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5',
          compact && 'col-start-2 row-start-1 self-center',
        )}
      >
        {record.question.options.map((option, index) => (
          <Hint key={option.label} label={option.consequences}>
            <Button
              type="button"
              variant={index === 0 ? 'secondary' : 'ghost'}
              disabled={!enabled}
              onClick={() =>
                actions.onAnswer(session, {
                  option: option.label,
                  ...(text.trim() ? { text: text.trim() } : {}),
                })
              }
            >
              {option.label}
            </Button>
          </Hint>
        ))}
        {compact && (
          <Button
            type="button"
            variant="ghost"
            disabled={!enabled}
            aria-expanded={writing}
            onClick={() => setWriting(value => !value)}
          >
            Other answer
          </Button>
        )}
      </div>
      {writing && (
        <form
          aria-label="Answer the question"
          className={cn(fullWidth, compact && 'pt-1.5')}
          onSubmit={event => {
            event.preventDefault();
            if (!enabled || !text.trim()) return;
            actions.onAnswer(session, { text: text.trim() });
          }}
        >
          <Composer variant="compact">
            <ComposerInput
              aria-label="Answer"
              placeholder="Answer in your own words, or add a note to an option"
              maxLength={TEXT_LIMIT}
              value={text}
              disabled={!enabled}
              onChange={event => setText(event.target.value)}
            />
            <ComposerToolbar
              start={<span>The session continues with your answer.</span>}
              end={
                <ComposerSend
                  label="Send answer"
                  disabled={!enabled || !text.trim()}
                />
              }
            />
          </Composer>
        </form>
      )}
      {deciding && (
        <StatusMessage tone="loading" className={fullWidth || undefined}>
          Sending answer…
        </StatusMessage>
      )}
      {actions.errors[key] && (
        <StatusMessage tone="error" className={fullWidth || undefined}>
          {actions.errors[key]}
        </StatusMessage>
      )}
    </div>
  );
}
