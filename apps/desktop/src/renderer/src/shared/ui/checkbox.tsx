import type { ComponentProps } from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from 'cn';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';

export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer focus-ring-offset group/checkbox grid size-3.5 shrink-0 place-items-center rounded-sm border border-input bg-transparent text-primary-foreground shadow-xs transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-error-foreground data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary dark:bg-input/30',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center">
        <Check
          aria-hidden="true"
          className="size-3 stroke-3 group-data-[state=indeterminate]/checkbox:hidden"
        />
        <Minus
          aria-hidden="true"
          className="hidden size-3 stroke-3 group-data-[state=indeterminate]/checkbox:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
