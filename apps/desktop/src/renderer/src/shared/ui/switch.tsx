import * as React from 'react';
import { cn } from '@/shared/lib/cn';
import { Switch as SwitchPrimitive } from 'radix-ui';

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer focus-ring-offset inline-flex h-[1.125rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform duration-base ease-out data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
