import { RefreshCw } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import {
  providers,
  providerStatusLabel,
  type Provider,
  type ProviderState,
  type ProviderStates,
} from '@/entities/session';
import { HostStatus } from '@/features/host-status';
import { IconButton } from '@/shared/ui/icon-button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';

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
                onRefresh={onRefreshConnection}
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
        />
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
                        {provider === 'Claude Code'
                          ? 'claude auth login'
                          : 'codex login'}
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
    </div>
  );
}
