import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import type { SessionFailure } from '@nesvo/contracts';
import { ExitCodeBadge } from '@/entities/activity';
import type { Provider } from '@/entities/session';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { availableIn, hasReset, resetLabel } from './reset-time';

const RESET_TICK_MS = 30_000;

const signInCommands: Record<Provider, string> = {
  'Claude Code': 'claude auth login',
  Codex: 'codex login',
};

export type FailureNoticeProps = {
  failure: SessionFailure | null;
  error: string;
  provider: Provider;
  computerName?: string;
  canResend: boolean;
  resendDisabled?: boolean;
  checking?: boolean;
  providerStatus?: string;
  onResend: () => void;
  onCheckProvider: () => void;
  className?: string;
};

const failureTitle = (failure: SessionFailure | null, provider: Provider) => {
  if (!failure) return 'The run failed';
  return {
    'usage-limit': 'Usage limit reached',
    'sign-in': `Sign in with ${provider}`,
    network: 'Connection problem',
    crash: `${provider} stopped unexpectedly`,
    timeout: 'The turn timed out',
    provider: 'The run failed',
    host: 'Nesvo could not finish this run',
  }[failure.kind];
};

const usageLine = (failure: SessionFailure, now: number) => {
  if (!failure.resetsAt)
    return failure.message || 'Try again after the limit resets.';
  const remaining = availableIn(failure.resetsAt, now);
  return (
    <>
      {resetLabel(failure.resetsAt, now)}
      {remaining && <span aria-live="off"> · {remaining}</span>}
    </>
  );
};

const ResendButton = ({
  label,
  variant = 'outline',
  disabled,
  onResend,
}: {
  label: string;
  variant?: 'outline' | 'ghost';
  disabled: boolean;
  onResend: () => void;
}) => (
  <Button
    type="button"
    size="xs"
    variant={variant}
    disabled={disabled}
    onClick={onResend}
  >
    {label}
  </Button>
);

export const FailureNotice = ({
  failure,
  error,
  provider,
  computerName = 'this computer',
  canResend,
  resendDisabled = false,
  checking = false,
  providerStatus = '',
  onResend,
  onCheckProvider,
  className,
}: FailureNoticeProps) => {
  const now = useNow(RESET_TICK_MS);
  const [checked, setChecked] = useState(false);
  const kind = failure?.kind ?? null;
  const message = failure?.message || error;
  const resetPassed =
    kind === 'usage-limit' && !!failure?.resetsAt
      ? hasReset(failure.resetsAt, now)
      : false;
  let line: ReactNode = message;
  if (kind === 'usage-limit' && failure) line = usageLine(failure, now);
  if (kind === 'sign-in')
    line = `Run this on ${computerName}, then check again.`;
  const checkProvider = () => {
    setChecked(true);
    onCheckProvider();
  };
  return (
    <section
      role="alert"
      aria-label="Failed run"
      data-failure-kind={kind ?? 'unknown'}
      className={cn(
        'space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3',
        className,
      )}
    >
      <div className="space-y-0.5">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {failureTitle(failure, provider)}
          </span>
          {kind === 'crash' && failure?.exitCode != null && (
            <ExitCodeBadge code={failure.exitCode} />
          )}
        </p>
        {line && (
          <p className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {line}
          </p>
        )}
      </div>
      {kind === 'sign-in' && (
        <pre
          aria-label="Sign-in command"
          className="w-fit max-w-full overflow-x-auto rounded-md border bg-code-background px-2.5 py-1.5 font-mono text-xs"
        >
          <code>{signInCommands[provider]}</code>
        </pre>
      )}
      {kind === 'crash' && failure?.detail && (
        <details className="group/failure-detail">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors duration-100 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform duration-150 group-open/failure-detail:rotate-90" />
            Details
          </summary>
          <pre
            aria-label="Failure details"
            className="mt-1.5 max-h-48 overflow-auto rounded-md border bg-code-background p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {failure.detail}
          </pre>
        </details>
      )}
      {kind === 'sign-in' && checked && providerStatus && (
        <p role="status" className="text-xs text-muted-foreground">
          {providerStatus}
        </p>
      )}
      {(canResend || kind === 'sign-in') && (
        <div className="flex flex-wrap gap-2">
          {kind === 'sign-in' && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={checking}
              onClick={checkProvider}
            >
              Check again
            </Button>
          )}
          {canResend && kind === 'usage-limit' && failure?.resetsAt && (
            <ResendButton
              label="Resend after reset"
              disabled={resendDisabled || !resetPassed}
              onResend={onResend}
            />
          )}
          {canResend && kind === 'usage-limit' && (
            <ResendButton
              label="Resend now"
              variant={failure?.resetsAt ? 'ghost' : 'outline'}
              disabled={resendDisabled}
              onResend={onResend}
            />
          )}
          {canResend && kind !== 'usage-limit' && (
            <ResendButton
              label="Resend last message"
              variant={kind === 'sign-in' ? 'ghost' : 'outline'}
              disabled={resendDisabled}
              onResend={onResend}
            />
          )}
        </div>
      )}
    </section>
  );
};
