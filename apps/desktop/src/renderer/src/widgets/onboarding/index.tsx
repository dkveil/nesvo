import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { Provider } from '@/entities/session';
import { useDefaultSessionFolders } from '@/features/default-session-folder';
import { Button } from '@/shared/ui/button';
import { Progress } from '@/shared/ui/progress';
import { SectionLabel } from '@/shared/ui/section-label';
import { ComputersStep } from './computers-step';
import { FinishStep } from './finish-step';
import { InboxStep } from './inbox-step';
import { ProvidersStep } from './providers-step';
import { RoutinesStep, type RoutineOutcomes } from './routines-step';
import { SetupStep } from './setup-step';
import { useOnboardingComputers } from './use-onboarding-computers';
import { WelcomeStep } from './welcome-step';

type Props = {
  onStartSession: (provider: Provider | null) => void;
  onClose: () => void;
};

const steps = [
  { id: 'welcome' },
  {
    id: 'providers',
    title: 'Coding agents',
    description: 'Nesvo runs the agents you already have installed.',
  },
  {
    id: 'computers',
    title: 'Computers',
    description:
      'Choose where local sessions start or connect a server over SSH.',
  },
  {
    id: 'setup',
    title: 'Your setup',
    description: 'See the tools and working rules your agents bring with them.',
  },
  {
    id: 'inbox',
    title: 'Your Inbox',
    description: 'Choose what reaches you and when agents wait for you.',
  },
  {
    id: 'routines',
    title: 'Starter routines',
    description: 'Add editable templates for work you repeat.',
  },
  { id: 'finish' },
] as const;

export function Onboarding({ onStartSession, onClose }: Props) {
  const api = window.nesvo;
  const [index, setIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<RoutineOutcomes>({});
  const { computers, local, error, statuses, checkProviders } =
    useOnboardingComputers(api);
  const defaultFolders = useDefaultSessionFolders(computers);
  const step = steps[index]!;
  const last = step.id === 'finish';
  const folder = defaultFolders.folders.local ?? null;
  useEffect(() => {
    document.getElementById('onboarding-step')?.focus();
  }, [index]);

  return (
    <main
      aria-label="Getting started"
      className="flex h-dvh flex-col bg-background font-onboarding text-foreground"
    >
      <div className="drag-region h-10 shrink-0" />
      <header className="mx-auto w-full max-w-3xl shrink-0 space-y-2 px-10 pt-4">
        <div className="flex items-center justify-between gap-4">
          <SectionLabel as="p" className="px-0">
            Getting started
          </SectionLabel>
          <p className="text-xs text-muted-foreground tabular-nums">
            Step {index + 1} of {steps.length}
          </p>
        </div>
        <Progress
          label="Getting started progress"
          value={((index + 1) / steps.length) * 100}
        />
      </header>
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <section
          id="onboarding-step"
          aria-labelledby="onboarding-title"
          tabIndex={-1}
          data-onboarding-step={step.id}
          className="mx-auto my-auto w-full max-w-3xl space-y-5 px-10 py-5 outline-none"
        >
          {'title' in step && (
            <header className="space-y-1.5">
              <h1
                id="onboarding-title"
                className="text-display-lg font-semibold tracking-tight"
              >
                {step.title}
              </h1>
              <p className="text-sm text-muted-foreground">
                {step.description}
              </p>
            </header>
          )}
          {step.id === 'welcome' && <WelcomeStep />}
          {step.id === 'providers' && (
            <ProvidersStep
              statuses={statuses}
              computerName={local?.name ?? 'this computer'}
              onCheckAgain={checkProviders}
            />
          )}
          {step.id === 'computers' && (
            <ComputersStep
              computers={computers}
              defaultFolders={defaultFolders}
              api={api}
              error={error}
            />
          )}
          {step.id === 'setup' && (
            <SetupStep
              api={api}
              hostId="local"
              directory={folder ?? ''}
              statuses={statuses}
              onSetupAgents={() => setIndex(1)}
            />
          )}
          {step.id === 'inbox' && <InboxStep api={api} computer={local} />}
          {step.id === 'routines' && (
            <RoutinesStep
              api={api}
              computer={local}
              statuses={statuses}
              defaultFolder={folder}
              outcomes={outcomes}
              setOutcomes={setOutcomes}
              onChooseComputer={() => setIndex(2)}
              onSetupAgents={() => setIndex(1)}
            />
          )}
          {last && (
            <FinishStep
              computers={computers}
              statuses={statuses}
              folder={folder}
              routines={Object.values(outcomes).flatMap(item =>
                item.status === 'added' ? [item.name] : [],
              )}
              onClose={onClose}
              onStartSession={onStartSession}
            />
          )}
        </section>
      </div>
      <footer className="mx-auto w-full max-w-3xl shrink-0 px-10 pb-6">
        <nav
          aria-label="Guide navigation"
          className="flex items-center justify-between gap-2 border-t pt-4"
        >
          <div className="flex gap-2">
            {index > 0 && (
              <Button
                variant="ghost"
                size="md"
                onClick={() => setIndex(index - 1)}
              >
                <ArrowLeft />
                Back
              </Button>
            )}
          </div>
          {!last && (
            <div className="flex gap-2">
              <Button variant="ghost" size="md" onClick={onClose}>
                Skip
              </Button>
              <Button size="md" onClick={() => setIndex(index + 1)}>
                {index === 0 ? 'Get started' : 'Continue'}
                <ArrowRight />
              </Button>
            </div>
          )}
        </nav>
      </footer>
    </main>
  );
}
