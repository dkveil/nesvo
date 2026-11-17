import type { ComponentProps } from 'react';
import { CircleCheck, CircleDot, CircleX } from 'lucide-react';
import type { PullRequestSummary } from '@nesvo/contracts';
import { cn } from 'cn';

const CHECK_LABELS = {
  pending: 'Checks pending',
  passing: 'Checks passing',
  failing: 'Checks failing',
} as const;

type ChecksIconProps = ComponentProps<'svg'> & {
  checks: PullRequestSummary['checks'];
};

export function ChecksIcon({ checks, className, ...props }: ChecksIconProps) {
  if (checks === 'none') return null;
  const Icon =
    checks === 'passing'
      ? CircleCheck
      : checks === 'failing'
        ? CircleX
        : CircleDot;
  return (
    <Icon
      role="img"
      aria-label={CHECK_LABELS[checks]}
      className={cn(
        'size-3 shrink-0',
        checks === 'passing' && 'text-success-foreground',
        checks === 'failing' && 'text-error-foreground',
        checks === 'pending' && 'text-warning-foreground',
        className,
      )}
      {...props}
    >
      <title>{CHECK_LABELS[checks]}</title>
    </Icon>
  );
}
