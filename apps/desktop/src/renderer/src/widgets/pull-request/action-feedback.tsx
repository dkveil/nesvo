import { cn } from 'cn';
import type { ActionState } from './use-pull-request-actions';

type ActionFeedbackProps = {
  state: ActionState | undefined;
  className?: string;
};

export function ActionFeedback({ state, className }: ActionFeedbackProps) {
  if (!state || state.status === 'pending' || !state.message) return null;
  return (
    <span
      role={state.status === 'error' ? 'alert' : 'status'}
      className={cn(
        'animate-in text-2xs leading-4 duration-150 fade-in-0 [overflow-wrap:anywhere]',
        state.status === 'error'
          ? 'text-error-foreground'
          : 'text-success-foreground',
        className,
      )}
    >
      {state.message}
    </span>
  );
}
