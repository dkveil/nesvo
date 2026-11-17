import type { ComponentProps } from 'react';
import { cn } from 'cn';
import { Badge } from '@/shared/ui/badge';

type ExitCodeBadgeProps = ComponentProps<'span'> & {
  code: number;
};

export const ExitCodeBadge = ({
  code,
  className,
  ...props
}: ExitCodeBadgeProps) => (
  <Badge
    variant="outline"
    aria-label={`Exit code ${code}`}
    data-exit-code={code}
    className={cn(
      'h-4 rounded-sm px-1 font-mono text-2xs leading-none font-normal text-muted-foreground',
      code !== 0 && 'border-destructive/40 text-destructive',
      className,
    )}
    {...props}
  >
    exit {code}
  </Badge>
);
