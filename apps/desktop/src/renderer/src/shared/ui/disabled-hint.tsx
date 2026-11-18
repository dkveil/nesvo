import type { ReactNode } from 'react';
import {
  Hint,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/shared/ui/tooltip';

type DisabledHintProps = {
  reason: string;
  hint?: string;
  children: ReactNode;
};

export function DisabledHint({ reason, hint, children }: DisabledHintProps) {
  if (!reason)
    return hint ? (
      <Hint label={hint} side="bottom">
        {children}
      </Hint>
    ) : (
      children
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="focus-ring inline-flex rounded-control">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" variant="panel">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
