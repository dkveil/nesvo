import { useState } from 'react';
import type { McpServer } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { ListRow } from '@/shared/ui/list-row';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  connectionLabels,
  connectionTones,
  scopeLabels,
  transportLabels,
} from './mcp-labels';
import type { McpConnections } from './use-mcp-connections';

export function McpConnectionFeedback({
  connections,
}: {
  connections: McpConnections;
}) {
  return (
    <>
      {connections.error && (
        <StatusMessage tone="error">{connections.error}</StatusMessage>
      )}
      {connections.list?.notice && (
        <StatusMessage>{connections.list.notice}</StatusMessage>
      )}
      {connections.pending?.kind === 'authorize' && (
        <StatusMessage tone="loading">
          Waiting for the provider to finish authorization…
        </StatusMessage>
      )}
      {connections.loading && (
        <StatusMessage tone="loading">Checking MCP connections…</StatusMessage>
      )}
    </>
  );
}

export function McpConnectionRows({
  servers,
  connections,
}: {
  servers: McpServer[];
  connections: McpConnections;
}) {
  const [logout, setLogout] = useState<McpServer | null>(null);
  const states = new Map(
    connections.list?.servers.map(server => [server.key, server]),
  );
  if (!servers.length)
    return <StatusMessage>No MCP servers found.</StatusMessage>;
  return (
    <>
      {servers.map(server => {
        const observed = states.get(server.key);
        const status = observed?.status;
        const action = observed?.actions.find(kind => kind !== 'logout');
        const pending = connections.pending?.serverKey === server.key;
        return (
          <ListRow
            key={server.key}
            density="two-line"
            size="sm"
            title={server.name}
            leading={status && <StatusDot tone={connectionTones[status]} />}
            description={
              <>
                {status && <>{connectionLabels[status]} · </>}
                <span>
                  {scopeLabels[server.scope]} ·{' '}
                  {server.transport
                    ? transportLabels[server.transport]
                    : 'Unknown transport'}
                </span>
                {server.problem && <> · {server.problem}</>}
              </>
            }
            actionsPlacement="visible"
            actions={
              (action || observed?.actions.includes('logout')) && (
                <>
                  {action && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={
                        (action === 'authorize' ? 'Authorize ' : 'Reconnect ') +
                        server.name
                      }
                      disabled={!!connections.pending || connections.loading}
                      onClick={() => void connections.act(action, server.key)}
                    >
                      {pending
                        ? action === 'authorize'
                          ? 'Authorizing…'
                          : 'Reconnecting…'
                        : action === 'authorize'
                          ? 'Authorize'
                          : 'Reconnect'}
                    </Button>
                  )}
                  {observed?.actions.includes('logout') && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={'Sign out of ' + server.name}
                      disabled={!!connections.pending || connections.loading}
                      onClick={() => setLogout(server)}
                    >
                      Sign out
                    </Button>
                  )}
                </>
              )
            }
          />
        );
      })}
      {logout && (
        <ConfirmDialog
          open
          onOpenChange={open => {
            if (!open) setLogout(null);
          }}
          title={'Sign out of ' + logout.name + '?'}
          description="The provider will remove the saved authorization for this server in this profile."
          confirmLabel="Sign out"
          tone="default"
          onConfirm={() => connections.act('logout', logout.key)}
        />
      )}
    </>
  );
}
