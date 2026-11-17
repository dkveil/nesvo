import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import type { ActionState } from './use-pull-request-actions';

type ActionFeedbackProps = {
  state: ActionState | undefined;
  className?: string;
};

const RECOVERY_BUTTON =
  'h-5 px-1.5 text-2xs text-muted-foreground enabled:hover:text-foreground';

export function ActionFeedback({ state, className }: ActionFeedbackProps) {
  if (!state || state.status === 'pending' || !state.message) return null;
  if (state.status === 'unknown')
    return (
      <span
        role="alert"
        className={cn(
          'inline-flex animate-in flex-wrap items-center gap-x-1 gap-y-0.5 text-2xs leading-4 text-warning-foreground duration-150 fade-in-0',
          className,
        )}
      >
        <span className="[overflow-wrap:anywhere]">{state.message}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={state.retry}
          className={RECOVERY_BUTTON}
        >
          Retry with the same request
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={state.refresh}
          className={RECOVERY_BUTTON}
        >
          Refresh
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={state.discard}
          className={RECOVERY_BUTTON}
        >
          Discard
        </Button>
      </span>
    );
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
