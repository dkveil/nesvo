import type { SessionContext } from '@nesvo/contracts';
import type { Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Meter } from '@/shared/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import type { ConversationAction } from './conversation-actions';
import {
  contextPercent,
  formatTokens,
  suggestsCompaction,
} from './context-fill';

type Props = {
  context: SessionContext | null;
  provider: Provider;
  compact?: Pick<ConversationAction, 'disabled' | 'run'>;
};

const reportedTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

export function ContextMeter({ context, provider, compact }: Props) {
  if (!context) return null;
  const percent = contextPercent(context);
  const high = suggestsCompaction(context);
  return (
    <div className="flex shrink-0 items-center gap-1" data-context-meter="">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="focus-ring flex h-6 items-center gap-1.5 rounded-control px-1.5 text-2xs text-muted-foreground tabular-nums"
          >
            <Meter
              value={percent}
              label="Context window"
              tone={high ? 'warning' : 'neutral'}
              className="w-10"
            />
            {percent}%
          </span>
        </TooltipTrigger>
        <TooltipContent variant="panel" side="top">
          <span className="block font-medium text-foreground">
            Context window
          </span>
          <span className="block tabular-nums">
            {formatTokens(context.usedTokens)} of{' '}
            {formatTokens(context.windowTokens)} tokens used ({percent}%)
          </span>
          <span className="block text-muted-foreground">
            Reported by {provider} at {reportedTime(context.reportedAt)}
          </span>
        </TooltipContent>
      </Tooltip>
      {high && compact && !compact.disabled && (
        <Button type="button" size="xs" variant="ghost" onClick={compact.run}>
          Compact
        </Button>
      )}
    </div>
  );
}
