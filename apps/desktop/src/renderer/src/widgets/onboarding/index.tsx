import { useState } from 'react';
import type {
  Computer,
  DesktopApi,
  DesktopScheduledJob,
} from '@nesvo/contracts';
import type { ProviderStates } from '@/entities/session';
import type { DefaultSessionFolders } from '@/features/default-session-folder';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Progress } from '@/shared/ui/progress';
import { SectionLabel } from '@/shared/ui/section-label';
import { ComputersStep } from './computers-step';
import { FinishStep } from './finish-step';
import { ProvidersStep } from './providers-step';
import { RoutinesStep } from './routines-step';
import { SetupStep } from './setup-step';
import { WelcomeStep } from './welcome-step';

type Props = {
  computer: Computer | undefined;
  statuses: ProviderStates;
  defaultFolders: DefaultSessionFolders;
  api: Pick<
    DesktopApi,
    | 'listMcpServers'
    | 'discoverSkills'
    | 'scheduledJobs'
    | 'workflows'
    | 'readCodeReviewSettings'
    | 'listTrackedRepositories'
  >;
  onCheckProviders: () => void;
  onAddComputer: () => void;
  onJobAdded: (job: DesktopScheduledJob) => void;
  onStartSession: () => void;
  onClose: () => void;
};

const steps = [
  {
    id: 'welcome',
    title: 'Welcome to Nesvo',
    description: 'A workspace for coding agents on your own computers.',
  },
  {
    id: 'providers',
    title: 'Coding agents',
    description: 'Nesvo runs the agents you already have installed.',
  },
  {
    id: 'computers',
    title: 'Computers',
    description: 'Where sessions run and where they start.',
  },
  {
    id: 'setup',
    title: 'Your setup',
    description: 'What your agents bring with them.',
  },
  {
    id: 'routines',
    title: 'Starter routines',
    description: 'Optional templates you can add and edit later.',
  },
  {
    id: 'finish',
    title: 'You are ready',
    description: 'Start with a session in your default folder.',
  },
] as const;

export function Onboarding({
  computer,
  statuses,
  defaultFolders,
  api,
  onCheckProviders,
  onAddComputer,
  onJobAdded,
  onStartSession,
  onClose,
}: Props) {
  const [index, setIndex] = useState(0);
  const step = steps[index]!;
  const last = index === steps.length - 1;
  const hostId = computer?.id ?? 'local';
  const folder = defaultFolders.folders[hostId] ?? null;
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby="onboarding-description"
        data-onboarding-step={step.id}
        className="w-[min(40rem,calc(100vw-2rem))] gap-5 sm:max-w-none"
      >
        <DialogHeader className="gap-2">
          <SectionLabel as="p" className="px-0">
            Getting started · {index + 1} of {steps.length}
          </SectionLabel>
          <Progress
            label="Getting started progress"
            value={((index + 1) / steps.length) * 100}
          />
          <DialogTitle className="pt-1 text-lg">{step.title}</DialogTitle>
          <DialogDescription id="onboarding-description">
            {step.description}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(28rem,calc(100dvh-16rem))] min-h-40 overflow-y-auto">
          {step.id === 'welcome' && <WelcomeStep />}
          {step.id === 'providers' && (
            <ProvidersStep
              statuses={statuses}
              computerName={computer?.name ?? 'this computer'}
              onCheckAgain={onCheckProviders}
            />
          )}
          {step.id === 'computers' && (
            <ComputersStep
              computer={computer}
              defaultFolders={defaultFolders}
              onAddComputer={onAddComputer}
            />
          )}
          {step.id === 'setup' && (
            <SetupStep
              api={api}
              hostId={hostId}
              directory={folder ?? ''}
              statuses={statuses}
            />
          )}
          {step.id === 'routines' && (
            <RoutinesStep
              api={api}
              computer={computer}
              statuses={statuses}
              defaultFolder={folder}
              onJobAdded={onJobAdded}
            />
          )}
          {step.id === 'finish' && (
            <FinishStep folder={folder} onStartSession={onStartSession} />
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="md" onClick={onClose}>
            {last ? 'Close' : 'Skip'}
          </Button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button
                variant="ghost"
                size="md"
                onClick={() => setIndex(index - 1)}
              >
                Back
              </Button>
            )}
            {!last && (
              <Button size="md" onClick={() => setIndex(index + 1)}>
                {index === 0 ? 'Get started' : 'Continue'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
