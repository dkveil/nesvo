import type { ComponentProps } from 'react';
import { cn } from 'cn';

export type ComposerChipProps = ComponentProps<'button'>;

export function ComposerChip({ className, ...props }: ComposerChipProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors duration-100 outline-none',
        'enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-3 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}
