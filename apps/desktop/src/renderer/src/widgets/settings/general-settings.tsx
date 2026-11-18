import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import {
  providerCommands,
  providers,
  providerStatusLabel,
  type Provider,
  type ProviderState,
  type ProviderStates,
} from '@/entities/session';
import { HostStatus } from '@/features/host-status';
import { useRunningAppsEnabled } from '@/features/running-apps/use-running-apps-enabled';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

type Props = {
  connection: 'connecting' | 'ready' | 'unavailable';
  computer: Computer | undefined;
  hostId: string;
  providerStates: ProviderStates;
  onRefreshConnection: () => void;
  onRefreshProvider: (provider: Provider) => void;
};

const syncFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function providerTone(state: ProviderState): StatusTone {
  if (state.loading) return 'loading';
  if (state.status?.status === 'ready') return 'success';
  return 'warning';
}

export function GeneralSettings({
  connection,
  computer,
  hostId,
  providerStates,
  onRefreshConnection,
  onRefreshProvider,
}: Props) {
  const name = computer?.name ?? 'Local';
  const [logsError, setLogsError] = useState('');
  const [runningApps, setRunningApps] = useRunningAppsEnabled();
  const openLogs = () => {
    setLogsError('');
    void window.nesvo.openLogs().catch(() => {
      setLogsError('The logs folder could not be opened.');
    });
  };
  return (
    <div className="space-y-8">
      <SettingsSection title="Connection">
        <SettingsRow
          title={name}
          description={
            <div className="space-y-1">
              <HostStatus
                connection={connection}
                name={name}
                local={hostId === 'local'}
              />
              {computer?.error && (
                <StatusMessage tone="error">{computer.error}</StatusMessage>
              )}
              {computer?.lastSyncedAt && connection !== 'ready' && (
                <p>
                  Offline snapshot · last synced{' '}
                  {syncFormat.format(new Date(computer.lastSyncedAt))}. Work may
                  still be running. Reconnecting will not replay commands.
                </p>
              )}
            </div>
          }
        >
          <IconButton
            label="Refresh connection"
            disabled={connection === 'connecting'}
            onClick={onRefreshConnection}
          >
            <RefreshCw />
          </IconButton>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Providers">
        {providers.map(provider => {
          const state = providerStates[provider];
          return (
            <SettingsRow
              key={provider}
              title={provider}
              description={
                <div className="space-y-1">
                  <StatusMessage tone={providerTone(state)}>
                    {providerStatusLabel(provider, state)}
                  </StatusMessage>
                  {state.error && (
                    <StatusMessage tone="error">{state.error}</StatusMessage>
                  )}
                  {state.status?.detail && (
                    <p className="whitespace-pre-wrap">{state.status.detail}</p>
                  )}
                  {state.status?.status === 'unauthenticated' && (
                    <p>
                      Sign in on {name} from its terminal with{' '}
                      <code className="rounded-sm bg-muted px-1 font-mono text-2xs">
                        {providerCommands[provider].signIn}
                      </code>
                      , then refresh status.
                    </p>
                  )}
                </div>
              }
            >
              <IconButton
                label={`Refresh ${provider} status`}
                disabled={state.loading}
                onClick={() => onRefreshProvider(provider)}
              >
                <RefreshCw />
              </IconButton>
            </SettingsRow>
          );
        })}
      </SettingsSection>
      <SettingsSection title="Running apps">
        <SettingsRow
          title={
            <label htmlFor="settings-running-apps">Show running apps</label>
          }
          description="Shows the ports of apps that sessions started, such as development servers, next to each session. Every connected computer reads its own listening ports every few seconds; Nesvo never stops or restarts them."
        >
          <Switch
            id="settings-running-apps"
            checked={runningApps}
            onCheckedChange={setRunningApps}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <SettingsRow
          title="Logs"
          description={
            <div className="space-y-1">
              <p>Recent app and local host logs stay on this device.</p>
              {logsError && (
                <StatusMessage tone="error">{logsError}</StatusMessage>
              )}
            </div>
          }
        >
          <Button variant="outline" onClick={openLogs}>
            Open logs
          </Button>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
