import type { ComponentProps } from 'react';
import { cn } from 'cn';
import { providerMarks, type Provider } from './index';

export type ProviderGlyphProps = ComponentProps<'span'> & {
  provider: Provider;
};

export function ProviderGlyph({
  provider,
  className,
  ...props
}: ProviderGlyphProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="provider-glyph"
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-foreground/10 text-[7px] leading-none font-bold tracking-tight text-foreground/80',
        className,
      )}
      {...props}
    >
      {providerMarks[provider]}
    </span>
  );
}
