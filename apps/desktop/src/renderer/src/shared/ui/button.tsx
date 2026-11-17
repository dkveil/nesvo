import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/shared/lib/cn';
import { Slot } from 'radix-ui';

const buttonVariants = cva(
  "focus-ring press inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,scale] duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-invalid:border-error-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground [--focus-ring-color:var(--primary-foreground)] not-disabled:hover:bg-primary/90',
        destructive:
          'bg-destructive text-white [--focus-ring-color:white] not-disabled:hover:bg-destructive/90 dark:bg-destructive/70 dark:not-disabled:hover:bg-destructive/80',
        outline:
          'border bg-background shadow-xs not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:not-disabled:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground not-disabled:hover:bg-highlight',
        ghost:
          'not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground data-selected:bg-highlight data-selected:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground',
        link: 'text-primary underline-offset-4 not-disabled:hover:underline',
      },
      size: {
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 text-ui has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        md: 'h-8 gap-1.5 px-3 text-ui has-[>svg]:px-2.5',
        lg: 'h-9 px-4 text-sm has-[>svg]:px-3',
        default: 'h-9 px-4 text-sm has-[>svg]:px-3',
        inline: 'h-auto gap-1 rounded-sm p-0',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7',
        'icon-md': 'size-8',
        icon: 'size-9',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'sm',
    },
  },
);

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    selected?: boolean;
  };

function Button({
  className,
  variant = 'default',
  size = 'sm',
  asChild = false,
  selected,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-selected={selected ? '' : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants, type ButtonProps };
