import { RefreshCw } from 'lucide-react';
import {
  ProviderGlyph,
  providers,
  type ProviderStates,
} from '@/entities/session';
import {
  providerSteps,
  providerSummary,
} from '@/features/provider-setup/provider-steps';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  statuses: ProviderStates;
  computerName: string;
  onCheckAgain: () => void;
};

export function ProvidersStep({ statuses, computerName, onCheckAgain }: Props) {
  const checking = providers.some(provider => statuses[provider].loading);
  const missing = providers.some(
    provider => providerSteps(provider, statuses[provider]).length > 0,
  );
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-surface border bg-card">
        {providers.map(provider => {
          const state = statuses[provider];
          const summary = providerSummary(provider, state);
          const steps = providerSteps(provider, state);
          return (
            <li
              key={provider}
              aria-label={provider}
              data-onboarding-provider={provider}
              className="space-y-2 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <ProviderGlyph
                  provider={provider}
                  className="size-4 text-muted-foreground"
                />
                <p className="min-w-0 flex-1 truncate text-ui font-medium">
                  {provider}
                </p>
                <StatusMessage tone={summary.tone}>
                  {summary.label}
                </StatusMessage>
              </div>
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
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-muted-foreground">
          {missing
            ? `Run the commands in a terminal on ${computerName}, then check again. One provider is enough to start.`
            : `Nesvo uses the providers installed on ${computerName} with their existing sign-in.`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={checking}
          aria-busy={checking || undefined}
          onClick={onCheckAgain}
        >
          <RefreshCw />
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </div>
  );
}
