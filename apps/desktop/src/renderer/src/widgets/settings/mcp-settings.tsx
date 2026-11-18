import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Computer, Provider, ProviderProfile } from '@nesvo/contracts';
import { providers } from '@/entities/session';
import {
  McpConnectionFeedback,
  McpConnectionRows,
} from '@/features/session-mcp/mcp-connection-rows';
import { useMcpConnections } from '@/features/session-mcp/use-mcp-connections';
import { IconButton } from '@/shared/ui/icon-button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';

export function McpSettings({
  computer,
  profiles,
}: {
  computer?: Computer;
  profiles?: ProviderProfile[];
}) {
  const [provider, setProvider] = useState<Provider>('Claude Code');
  const [selection, setSelection] = useState('default');
  const available =
    profiles?.filter(profile => profile.provider === provider) ?? [];
  const profileId = available.find(profile => profile.id === selection)?.id;
  const supported = computer?.capabilities.includes('mcp-auth');
  const connected = computer?.status === 'connected';
  const connections = useMcpConnections(
    computer?.id ?? 'local',
    { provider, profileId },
    !!connected && !!supported,
  );
  return (
    <>
      <SettingsSection title="Connection">
        <SettingsRow title="Provider">
          <Select
            value={provider}
            onValueChange={value => {
              setProvider(value as Provider);
              setSelection('default');
            }}
          >
            <SelectTrigger aria-label="MCP provider" variant="ghost">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map(item => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        {available.length > 0 && (
          <SettingsRow title="Profile">
            <Select value={profileId ?? 'default'} onValueChange={setSelection}>
              <SelectTrigger aria-label="MCP provider profile" variant="ghost">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default profile</SelectItem>
                {available.map(profile => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}
      </SettingsSection>
      <SettingsSection
        title="MCP servers"
        action={
          <IconButton
            size={24}
            label="Refresh MCP connections"
            disabled={
              !connections.enabled ||
              connections.loading ||
              !!connections.pending
            }
            onClick={() => void connections.refresh()}
          >
            <RefreshCw />
          </IconButton>
        }
      >
        {!connected ? (
          <StatusMessage>
            Connect this computer to check its MCP servers.
          </StatusMessage>
        ) : !supported ? (
          <StatusMessage>
            Update this computer’s Nesvo host to manage MCP authorization.
          </StatusMessage>
        ) : (
          <>
            <McpConnectionFeedback connections={connections} />
            {connections.list && (
              <McpConnectionRows
                servers={connections.list.servers}
                connections={connections}
              />
            )}
          </>
        )}
      </SettingsSection>
    </>
  );
}
