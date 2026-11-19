import { useState } from 'react';
import { isWritableSessionMode, type SessionMode } from '@nesvo/contracts';
import { modeLabel, type Session } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { stageKey, type StageActions } from './use-stage-decisions';

type Props = {
  session: Session;
  actions: StageActions;
  compact?: boolean;
};

type Panel = 'approve' | 'correct' | null;

const TEXT_LIMIT = 4000;

export function PlanDecision({ session, actions, compact = false }: Props) {
  const plan = session.plan;
  const [panel, setPanel] = useState<Panel>(null);
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [resolutions, setResolutions] = useState('');
  const [correction, setCorrection] = useState('');
  if (!plan || plan.status !== 'plan-ready') return null;
  const key = stageKey(session, plan.id);
  const deciding = !!actions.pending[key];
  const enabled = actions.isEnabled(session) && !deciding;
  const writable = actions.modesFor(session).filter(isWritableSessionMode);
  const options = writable.includes(plan.targetMode)
    ? writable
    : [plan.targetMode, ...writable];
  const chosen = mode ?? plan.targetMode;
  const fullWidth = compact && 'col-span-full';
  const toggle = (next: Exclude<Panel, null>) =>
    setPanel(current => (current === next ? null : next));
  return (
    <div className={compact ? 'contents' : 'space-y-2'}>
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5',
          compact && 'col-start-2 row-start-1 self-center',
        )}
      >
        <Button
          type="button"
          variant={compact ? 'secondary' : 'default'}
          disabled={!enabled}
          aria-expanded={panel === 'approve'}
          onClick={() => toggle('approve')}
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!enabled}
          aria-expanded={panel === 'correct'}
          onClick={() => toggle('correct')}
        >
          Correct
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!enabled}
          onClick={() => actions.onPlan(session, { decision: 'decline' })}
        >
          Reject
        </Button>
      </div>
      {panel === 'approve' && (
        <form
          aria-label="Approve plan"
          className={cn(fullWidth, compact && 'pt-1.5')}
          onSubmit={event => {
            event.preventDefault();
            if (!enabled) return;
            actions.onPlan(session, {
              decision: 'accept',
              mode: chosen,
              ...(resolutions.trim() ? { text: resolutions.trim() } : {}),
            });
          }}
        >
          <Composer variant="compact">
            <ComposerInput
              aria-label="Resolutions"
              placeholder="Resolutions for the open points (optional)"
              maxLength={TEXT_LIMIT}
              value={resolutions}
              disabled={!enabled}
              onChange={event => setResolutions(event.target.value)}
            />
            <ComposerToolbar
              start={
                <Select
                  value={chosen}
                  disabled={!enabled}
                  onValueChange={value => setMode(value as SessionMode)}
                >
                  <SelectTrigger
                    variant="ghost"
                    aria-label="Mode after approval"
                    className="w-auto"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map(option => (
                      <SelectItem key={option} value={option}>
                        {modeLabel(session.provider, option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
              end={<ComposerSend label="Approve and run" disabled={!enabled} />}
            />
          </Composer>
        </form>
      )}
      {panel === 'correct' && (
        <form
          aria-label="Correct plan"
          className={cn(fullWidth, compact && 'pt-1.5')}
          onSubmit={event => {
            event.preventDefault();
            if (!enabled || !correction.trim()) return;
            actions.onPlan(session, {
              decision: 'correct',
              text: correction.trim(),
            });
          }}
        >
          <Composer variant="compact">
            <ComposerInput
              aria-label="Correction"
              placeholder="What should the plan change?"
              maxLength={TEXT_LIMIT}
              value={correction}
              required
              disabled={!enabled}
              onChange={event => setCorrection(event.target.value)}
            />
            <ComposerToolbar
              start={<span>Plans again without changing files.</span>}
              end={
                <ComposerSend
                  label="Send correction"
                  disabled={!enabled || !correction.trim()}
                />
              }
            />
          </Composer>
        </form>
      )}
      {deciding && (
        <StatusMessage tone="loading" className={fullWidth || undefined}>
          Sending decision…
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
