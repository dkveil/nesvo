import type { ComponentProps } from 'react';
import type { PullRequestSummary } from '@nesvo/contracts';
import { StatusIcon, type StatusKind } from '@/entities/status';

const CHECK_LABELS = {
  pending: 'Checks pending',
  passing: 'Checks passing',
  failing: 'Checks failing',
} as const;

const CHECK_STATUS: Record<keyof typeof CHECK_LABELS, StatusKind> = {
  pending: 'pending',
  passing: 'success',
  failing: 'error',
};

type ChecksIconProps = Omit<ComponentProps<'svg'>, 'children'> & {
  checks: PullRequestSummary['checks'];
};

export function ChecksIcon({ checks, ...props }: ChecksIconProps) {
  if (checks === 'none') return null;
  return (
    <StatusIcon
      status={CHECK_STATUS[checks]}
      label={CHECK_LABELS[checks]}
      {...props}
    />
  );
}
