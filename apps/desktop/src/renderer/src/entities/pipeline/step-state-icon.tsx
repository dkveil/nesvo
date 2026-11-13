import {
  CircleCheck,
  CircleDashed,
  CircleExclamationPoint,
  CircleMinus,
  CirclePause,
  CircleQuestionMark,
  CircleX,
  Hand,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import type { PipelineStepState } from '@nesvo/contracts';
import { stepStateTones, toneText } from './index';

const stateIcons: Record<PipelineStepState, LucideIcon> = {
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
};

type StepStateIconProps = {
  state: PipelineStepState;
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
