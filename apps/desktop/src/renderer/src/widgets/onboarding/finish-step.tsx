import {
  ArrowRight,
  Bot,
  FolderOpen,
  Monitor,
  SquarePen,
  Workflow,
} from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import {
  providers,
  providerUsable,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';

type Props = {
  computers: Computer[];
  statuses: ProviderStates;
  folder: string | null;
  routines: string[];
  onStartSession: (provider: Provider | null) => void;
  onClose: () => void;
};

export function FinishStep({
  computers,
  statuses,
  folder,
  routines,
  onStartSession,
  onClose,
}: Props) {
  const ready = providers.find(provider => providerUsable(statuses[provider]));
  const detected = providers.filter(provider => {
    const status = statuses[provider].status?.status;
    return (
      status === 'ready' ||
      status === 'unauthenticated' ||
      status === 'unsupported'
    );
  });
  const summary = [
    {
      icon: Bot,
      label: 'Agents detected',
      value:
        detected.join(', ') ||
        (providers.some(provider => statuses[provider].loading)
          ? 'Checking…'
          : 'None detected'),
    },
    {
      icon: Monitor,
      label: 'Computers',
      value: computers.map(computer => computer.name).join(', ') || 'Local',
    },
    {
      icon: FolderOpen,
      label: 'Local default folder',
      value: folder ?? 'Isolated folder',
      path: folder,
    },
    {
      icon: Workflow,
      label: 'Routines added',
      value: routines.join(', ') || 'None added',
    },
  ];
  return (
    <div className="space-y-6 text-center">
      <header className="space-y-3">
        <h1
          id="onboarding-title"
          className="text-display font-semibold tracking-tight"
        >
          You’re ready to start
        </h1>
      </header>
      <dl className="mx-auto max-w-lg divide-y text-left">
        {summary.map(({ icon: Icon, label, value, path }) => (
          <div
            key={label}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] items-center gap-4 px-3 py-3"
          >
            <dt className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {label}
            </dt>
            <dd className="min-w-0 text-right text-ui">
              {path ? (
                <MiddleTruncatedText
                  path
                  value={path}
                  className="justify-end"
                />
              ) : (
                <p className="truncate" title={value}>
                  {value}
                </p>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="md" onClick={() => onStartSession(ready ?? null)}>
          <SquarePen />
          Start your first session
        </Button>
        <Button variant="outline" size="md" onClick={onClose}>
          <ArrowRight />
          Open workspace
        </Button>
      </div>
    </div>
  );
}
