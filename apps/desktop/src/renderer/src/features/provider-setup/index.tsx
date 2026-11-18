import { RefreshCw, TerminalSquare } from 'lucide-react';
import {
  ProviderGlyph,
  providerCommands,
  providers,
  type Provider,
  type ProviderState,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { EmptyState } from '@/shared/ui/empty-state';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';

type ProviderSetupProps = {
  statuses: ProviderStates;
  computerName: string;
  onCheckAgain: () => void;
};

type Step = { label: string; code: string };

function providerSummary(
  provider: Provider,
  { status, error, loading }: ProviderState,
): { tone: StatusTone; label: string } {
  if (loading) return { tone: 'loading', label: `Checking ${provider}…` };
  if (error) return { tone: 'error', label: 'Could not check' };
  const version = status?.version ? ` · ${status.version}` : '';
  switch (status?.status) {
    case 'ready':
      return { tone: 'success', label: `Detected${version}` };
    case 'unauthenticated':
      return { tone: 'warning', label: `Detected${version} · Not signed in` };
    case 'unsupported':
      return { tone: 'warning', label: `Detected${version} · Update needed` };
    case 'missing':
      return { tone: 'warning', label: 'Not installed' };
    default:
      return { tone: 'error', label: 'Unavailable' };
  }
}

function providerSteps(provider: Provider, { status }: ProviderState): Step[] {
  const { install, signIn } = providerCommands[provider];
  const installStep = { label: 'Install', code: install };
  const updateStep = { label: 'Update', code: install };
  const signInStep = { label: 'Sign in', code: signIn };
  switch (status?.status) {
    case 'ready':
      return [];
    case 'unauthenticated':
      return [signInStep];
    case 'unsupported':
      return [updateStep, signInStep];
    default:
      return [installStep, signInStep];
  }
}

export function ProviderSetup({
  statuses,
  computerName,
  onCheckAgain,
}: ProviderSetupProps) {
  const checking = providers.some(provider => statuses[provider].loading);
  return (
    <section
      aria-label="Coding agent setup"
      data-provider-setup
      className="space-y-4"
    >
      <EmptyState
        size="sm"
        icon={TerminalSquare}
        title="Set up a coding agent"
        description={`Nesvo runs the Claude Code or Codex already installed on ${computerName} with its existing sign-in. Run these commands in a terminal on ${computerName}, then check again.`}
        className="py-0"
        action={
          <Button
            variant="outline"
            size="md"
            disabled={checking}
            aria-busy={checking || undefined}
            onClick={onCheckAgain}
          >
            <RefreshCw />
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        }
      />
      <ul className="grid gap-3">
        {providers.map(provider => {
          const state = statuses[provider];
          const summary = providerSummary(provider, state);
          const steps = providerSteps(provider, state);
          return (
            <li
              key={provider}
              aria-label={provider}
              data-provider-setup-item={provider}
              className="min-w-0 space-y-2.5 rounded-surface border bg-card p-3"
            >
              <div className="flex items-center gap-2">
                <ProviderGlyph
                  provider={provider}
                  className="size-4 text-muted-foreground"
                />
                <p className="min-w-0 flex-1 truncate text-ui font-medium">
                  {provider}
                </p>
              </div>
              <StatusMessage tone={summary.tone}>{summary.label}</StatusMessage>
              {state.error && (
                <p className="text-xs text-muted-foreground">{state.error}</p>
              )}
              {!state.error &&
                state.status?.detail &&
                state.status.status !== 'missing' && (
                  <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
                    {state.status.detail}
                  </p>
                )}
              {steps.length > 0 && (
                <CodeBlock
                  label={steps
                    .map((step, index) =>
                      index ? step.label.toLowerCase() : step.label,
                    )
                    .join(', then ')}
                  code={steps.map(step => step.code).join('\n')}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
