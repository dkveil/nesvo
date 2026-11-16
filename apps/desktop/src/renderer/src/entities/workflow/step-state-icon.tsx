import {
  CircleCheck,
  CircleDashed,
  CircleExclamationPoint,
  CircleMinus,
  CircleOff,
  CirclePause,
  CircleQuestionMark,
  CircleX,
  Hand,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { stepStateTones, toneText, type StepDisplayState } from './index';

const stateIcons: Record<StepDisplayState, LucideIcon> = {
  pending: CircleDashed,
  running: LoaderCircle,
  'awaiting-human': Hand,
  passed: CircleCheck,
  failed: CircleX,
  blocked: CircleExclamationPoint,
  done: CircleCheck,
  error: CircleX,
  skipped: CircleMinus,
  interrupted: CirclePause,
  uncertain: CircleQuestionMark,
  unreached: CircleOff,
};

type StepStateIconProps = {
  state: StepDisplayState;
  className?: string;
};

export function StepStateIcon({ state, className }: StepStateIconProps) {
  const Icon = stateIcons[state];
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'size-3.5 shrink-0',
        toneText[stepStateTones[state]],
        state === 'running' && 'animate-spin motion-reduce:animate-none',
        className,
      )}
    />
  );
}
