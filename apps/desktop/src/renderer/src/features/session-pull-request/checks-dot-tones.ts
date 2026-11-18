import type { PullRequestSummary } from '@nesvo/contracts';
import type { StatusDotTone } from '@/shared/ui/status-dot';

export const checksDotTones: Record<
  PullRequestSummary['checks'],
  StatusDotTone
> = {
  none: 'neutral',
  pending: 'warning',
  passing: 'success',
  failing: 'error',
};
