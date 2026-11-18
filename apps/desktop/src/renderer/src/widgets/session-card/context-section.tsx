import type { SessionContext } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import type { Provider } from '@/entities/session';
import {
  contextPercent,
  formatTokens,
  suggestsCompaction,
} from '@/features/conversation-context/context-fill';
import { cardSection } from '@/shared/ui/card-row-styles';
import { Meter } from '@/shared/ui/progress';
import { cardRowProps } from './card-row';

type Props = {
  context: SessionContext | null;
  provider: Provider;
};

export function ContextSection({ context, provider }: Props) {
  if (!context) return null;
  const percent = contextPercent(context);
  const used = formatTokens(context.usedTokens);
  const window = formatTokens(context.windowTokens);
  return (
    <section
      aria-label="Context window"
      className={cn(
        cardSection,
        'grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 py-2',
      )}
    >
      <div
        tabIndex={0}
        {...cardRowProps}
        data-context-row=""
        aria-label={`Context window: ${used} of ${window} tokens used (${percent}%), reported by ${provider}`}
        className="focus-ring col-span-3 grid h-6 grid-cols-subgrid items-center rounded-control px-2 text-xs"
      >
        <span className="text-muted-foreground">Context</span>
        <Meter
          label="Context window"
          value={percent}
          tone={suggestsCompaction(context) ? 'warning' : 'neutral'}
        />
        <span className="text-right font-semibold tabular-nums">
          {used} / {window}
        </span>
      </div>
    </section>
  );
}
