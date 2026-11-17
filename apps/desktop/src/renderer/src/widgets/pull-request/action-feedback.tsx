import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';
import type { ActionState } from './use-pull-request-actions';

type ActionFeedbackProps = {
  state: ActionState | undefined;
  className?: string;
};

export function ActionFeedback({ state, className }: ActionFeedbackProps) {
  if (!state || state.status === 'pending' || !state.message) return null;
  const appear = 'animate-in duration-base ease-out fade-in-0';
  if (state.status === 'unknown')
    return (
      <StatusMessage
        tone="warning"
        role="alert"
        className={cn(appear, 'items-center', className)}
      >
        {state.message}
        <span className="ml-1 inline-flex flex-wrap items-center gap-0.5 align-middle">
          <Button type="button" variant="ghost" size="xs" onClick={state.retry}>
            Retry with the same request
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={state.refresh}
          >
            Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={state.discard}
          >
            Discard
          </Button>
        </span>
      </StatusMessage>
    );
  return (
    <StatusMessage
      tone={state.status === 'error' ? 'error' : 'success'}
      className={cn(appear, className)}
    >
      {state.message}
    </StatusMessage>
  );
}
