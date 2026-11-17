import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

type DisabledHintProps = {
  reason: string;
  children: ReactNode;
};

export function DisabledHint({ reason, children }: DisabledHintProps) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" variant="panel" className="max-w-64">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
