import { useLayoutEffect, useState } from 'react';
import type { Provider } from '@/entities/session';
import { Workspace } from '@/pages/workspace';
import { TooltipProvider } from '@/shared/ui/tooltip';
import { Onboarding } from '@/widgets/onboarding';
import {
  readOnboardingCompleted,
  saveOnboardingCompleted,
} from '@/widgets/onboarding/onboarding-preference';

export function App() {
  const [onboardingOpen, setOnboardingOpen] = useState(
    () =>
      !readOnboardingCompleted() &&
      window.nesvo?.showsOnboardingOnLaunch() !== false,
  );
  const [initialSessionProvider, setInitialSessionProvider] =
    useState<Provider | null>();
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-onboarding', onboardingOpen);
    void window.nesvo?.setOnboardingOpen(onboardingOpen).catch(() => undefined);
  }, [onboardingOpen]);
  const openWorkspace = (provider?: Provider | null) => {
    saveOnboardingCompleted();
    setInitialSessionProvider(provider);
    setOnboardingOpen(false);
  };
  return (
    <TooltipProvider>
      {onboardingOpen ? (
        <Onboarding
          onClose={() => openWorkspace()}
          onStartSession={openWorkspace}
        />
      ) : (
        <Workspace
          onOpenOnboarding={() => setOnboardingOpen(true)}
          initialSessionProvider={initialSessionProvider}
        />
      )}
    </TooltipProvider>
  );
}
