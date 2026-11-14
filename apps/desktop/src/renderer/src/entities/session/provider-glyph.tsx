import type { ComponentProps } from 'react';
import { cn } from 'cn';
import type { Provider } from './index';

export type ProviderGlyphProps = ComponentProps<'svg'> & {
  provider: Provider;
};

const CLAUDE_RAYS =
  'M12 12L12.9 1.4M12 12L17.3 5.2M12 12L21.6 8.6M12 12L20 13.9M12 12L19.5 19.8M12 12L13.7 20.6M12 12L8.4 21.3M12 12L5.2 16.9M12 12L1.4 12.6M12 12L4.5 7.8M12 12L7.3 3';

const CODEX_LOOP = 'M12.4 13.6V4.3A2.8 2.8 0 0 1 18 4.3V9';

const LOOP_TURNS = [0, 60, 120, 180, 240, 300];

export function ProviderGlyph({
  provider,
  className,
  ...props
}: ProviderGlyphProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      data-slot="provider-glyph"
      data-provider={provider}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-3.5 shrink-0 text-foreground/85', className)}
      {...props}
    >
      {provider === 'Claude Code' ? (
        <path d={CLAUDE_RAYS} strokeWidth={2.4} />
      ) : (
        LOOP_TURNS.map(turn => (
          <path
            key={turn}
            d={CODEX_LOOP}
            strokeWidth={1.6}
            transform={`rotate(${turn} 12 12)`}
          />
        ))
      )}
    </svg>
  );
}
