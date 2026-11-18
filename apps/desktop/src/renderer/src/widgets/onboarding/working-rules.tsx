import { BookOpenCheck } from 'lucide-react';
import { useState } from 'react';
import type { DesktopApi, WorkingRulesReview } from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  providerUsable,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  api: Pick<DesktopApi, 'reviewWorkingRules'>;
  directory: string;
  statuses: ProviderStates;
  onSetupAgents: () => void;
};

export function WorkingRules({
  api,
  directory,
  statuses,
  onSetupAgents,
}: Props) {
  const [selected, setSelected] = useState<Provider>();
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState<WorkingRulesReview | null>(null);
  const [error, setError] = useState('');
  const ready = providers.filter(provider =>
    providerUsable(statuses[provider]),
  );
  const provider = selected && ready.includes(selected) ? selected : ready[0];
  const status = provider ? statuses[provider].status : null;
  const model = provider === 'Claude Code' ? 'default' : status?.models[0]?.id;

  const summarize = async () => {
    if (!provider || !model || pending) return;
    setPending(true);
    setError('');
    setReview(null);
    try {
      setReview(await api.reviewWorkingRules({ provider, directory, model }));
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      aria-label="Bring your working rules"
      className="space-y-3 rounded-surface border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <BookOpenCheck
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
        <h2 className="text-title font-medium">Bring your working rules</h2>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Get a read-only summary of your user and project instruction files from
        an agent. The selected agent receives their text for the summary.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {provider && (
          <Select
            value={provider}
            onValueChange={value =>
              setSelected(providers.find(item => item === value))
            }
            disabled={pending}
          >
            <SelectTrigger aria-label="Agent for working rules" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ready.map(item => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {provider ? (
          <Button
            variant="outline"
            disabled={pending || !model}
            onClick={() => void summarize()}
          >
            {pending ? 'Summarizing…' : 'Summarize my rules'}
          </Button>
        ) : (
          <Button variant="outline" onClick={onSetupAgents}>
            Choose an agent
          </Button>
        )}
        {pending && (
          <StatusMessage tone="loading">Waiting for the agent…</StatusMessage>
        )}
      </div>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {review && (
        <div
          role="log"
          aria-label="Working rules summary"
          tabIndex={0}
          className="max-h-36 space-y-2 overflow-y-auto rounded-control border bg-background p-3 focus-ring"
        >
          <p className="whitespace-pre-wrap text-ui [overflow-wrap:anywhere]">
            {review.summary}
          </p>
          {review.sources.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {review.sources.join(' · ')}
            </p>
          )}
          {review.limited && (
            <p className="text-xs text-muted-foreground">
              The review covered a limited set of files or excerpts.
            </p>
          )}
        </div>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        The planned lessons feature will keep rules in files shared across
        providers, learn from your corrections and show how often each rule
        fails so you can improve autonomous runs.
      </p>
    </section>
  );
}
