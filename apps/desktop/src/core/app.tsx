import { useEffect } from 'react';

import { useStore } from '@nanostores/react';

import { applyBrandTokens } from '../libs/ui/apply-brand-tokens';
import { $hostConfig, $needsPairing } from '../modules/connection/core/connection-store';
import { ConnectionBadge } from '../modules/connection/presentation/connection-badge';
import { PairScreen } from '../modules/connection/presentation/pair-screen';
import { SessionsScreen } from '../modules/sessions/presentation/sessions-screen';
import { SettingsScreen } from '../modules/settings/presentation/settings-screen';
import { Button } from '../shared/components/button';
import {
  changeHostPort,
  forgetHost,
  pairHost,
  refreshHostSessions,
  startHostLink,
} from './host-actions';
import { bindHostEvents } from './host-events';
import { $screen } from './navigation-store';

applyBrandTokens();

export const App = () => {
  const screen = useStore($screen);
  const needsPairing = useStore($needsPairing);
  const config = useStore($hostConfig);

  useEffect(() => {
    let unbind: (() => void) | null = null;
    let disposed = false;
    bindHostEvents()
      .then(stop => {
        if (disposed) return stop();
        unbind = stop;
        return startHostLink();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unbind?.();
    };
  }, []);

  if (!config) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <span className="font-semibold">nesvo</span>
        <ConnectionBadge />
        <nav className="ml-auto flex gap-1">
          <Button variant="ghost" disabled={needsPairing} onClick={() => $screen.set('sessions')}>
            Sessions
          </Button>
          <Button variant="ghost" onClick={() => $screen.set('settings')}>
            Settings
          </Button>
        </nav>
      </header>
      <main className="flex-1 overflow-auto p-4">
        {needsPairing ? <PairScreen onPair={pairHost} /> : null}
        {!needsPairing && screen === 'sessions' ? (
          <SessionsScreen onRefresh={refreshHostSessions} />
        ) : null}
        {!needsPairing && screen === 'settings' ? (
          <SettingsScreen onSavePort={changeHostPort} onForgetPairing={forgetHost} />
        ) : null}
      </main>
    </div>
  );
};
