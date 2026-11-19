import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Computer, Provider, ProviderProfile } from '@nesvo/contracts';
import { errorDetail, providers } from '@/entities/session';
import {
  McpConnectionFeedback,
  McpConnectionRows,
} from '@/features/session-mcp/mcp-connection-rows';
import { useMcpConnections } from '@/features/session-mcp/use-mcp-connections';
import { IconButton } from '@/shared/ui/icon-button';
import { Button } from '@/shared/ui/button';
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
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [terminalError, setTerminalError] = useState('');
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
  const statusUnavailable = connections.list?.notice?.startsWith(
    `${provider} could not report MCP status.`,
  );
  const openTerminal = async () => {
    setOpeningTerminal(true);
    setTerminalError('');
    try {
      await window.nesvo.openMcpTerminal({ provider, profileId });
    } catch (failure) {
      setTerminalError(errorDetail(failure));
    } finally {
      setOpeningTerminal(false);
    }
  };
  return (
    <>
      <SettingsSection title="Connection">
        <SettingsRow title="Provider">
          <Select
            value={provider}
            onValueChange={value => {
              setProvider(value as Provider);
              setSelection('default');
              setTerminalError('');
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
            <Select
              value={profileId ?? 'default'}
              onValueChange={value => {
                setSelection(value);
                setTerminalError('');
              }}
            >
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
            <McpConnectionFeedback
              connections={connections}
              hideNotice={statusUnavailable}
            />
            {statusUnavailable && (
              <div className="flex min-w-0 items-center gap-2 px-2 py-1">
                <StatusMessage className="text-xs">
                  {provider} couldn’t report MCP status.
                </StatusMessage>
                {computer?.id === 'local' ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={openingTerminal}
                    onClick={() => void openTerminal()}
                  >
                    Open in terminal
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Open /mcp on {computer?.name}.
                  </span>
                )}
              </div>
            )}
            {terminalError && (
              <StatusMessage tone="error" className="px-3 py-1">
                {terminalError}
              </StatusMessage>
            )}
            {connections.list && (
              <McpConnectionRows
                servers={connections.list.servers}
                connections={connections}
                statusUnavailable={statusUnavailable}
              />
            )}
          </>
        )}
      </SettingsSection>
    </>
  );
}
