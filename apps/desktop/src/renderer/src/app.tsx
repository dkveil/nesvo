import { useEffect, useLayoutEffect, useState } from 'react';
import {
  readNotificationsEnabled,
  saveNotificationsEnabled,
} from '@/shared/lib/notification-preference';
import {
  readNewSessionDefaults,
  storeNewSessionDefaults,
} from '@/features/new-thread/new-session-defaults';
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
  useEffect(() => {
    const sync = () => {
      const current = readNewSessionDefaults();
      void window.nesvo.configuration
        .profile({
          action: 'seed',
          values: {
            notifications: readNotificationsEnabled(),
            newSession: {
              provider: current.provider,
              model: current.provider ? current.model : null,
              mode:
                current.provider && current.mode !== 'full-access'
                  ? current.mode
                  : null,
              worktree: current.worktree,
            },
          },
        })
        .then(profile => {
          if (profile.notifications !== undefined)
            saveNotificationsEnabled(profile.notifications);
          if (profile.newSession)
            storeNewSessionDefaults({
              ...readNewSessionDefaults(),
              ...profile.newSession,
            });
        })
        .catch(() => undefined);
    };
    sync();
    return window.nesvo.subscribe(event => {
      if (
        (event.type === 'host-snapshot' ||
          event.type === 'configuration-changed') &&
        event.hostId === 'local'
      )
        sync();
    });
  }, []);
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
