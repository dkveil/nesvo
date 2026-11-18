import { useRef, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import type { McpServerList } from '@nesvo/contracts';
import { errorDetail, modeLabel, type Provider } from '@/entities/session';
import { ComposerChip } from '@/features/new-thread/composer-chip';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Separator } from '@/shared/ui/separator';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { scopeLabels, transportLabels } from './mcp-labels';

type Props = {
  hostId: string;
  sessionId: string;
  provider: Provider;
  readOnly: boolean;
  disabled: boolean;
  unsupported: boolean;
};

type ListState =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; list: McpServerList };

export function McpChip({
  hostId,
  sessionId,
  provider,
  readOnly,
  disabled,
  unsupported,
}: Props) {
  const [state, setState] = useState<ListState>({ status: 'idle' });
  const request = useRef(0);
  const load = () => {
    const current = ++request.current;
    setState({ status: 'loading' });
    window.nesvo.listMcpServers({ sessionId }, hostId).then(
      list => {
        if (current === request.current) setState({ status: 'loaded', list });
      },
      failure => {
        if (current === request.current)
          setState({
            status: 'error',
            message:
              'Could not read MCP configuration. ' + errorDetail(failure),
          });
      },
    );
  };
  const hint = unsupported
    ? 'Update the host to view MCP configuration'
    : 'MCP servers and hooks';
  const list = state.status === 'loaded' ? state.list : null;
  const native = list?.configuration === 'native';
  return (
    <Popover onOpenChange={open => open && load()}>
      <Hint label={hint}>
        <PopoverTrigger asChild>
          <ComposerChip
            disabled={disabled || unsupported}
            aria-label={hint}
            data-session-mcp=""
            icon={<Plug aria-hidden="true" />}
          >
            MCP
          </ComposerChip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        aria-label="MCP servers and hooks"
        size="md"
        padding="none"
        scroll
        className="flex flex-col gap-2 p-2.5"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs text-muted-foreground">
            Settings come from {provider} on this computer.
          </p>
          <IconButton
            label="Refresh MCP configuration"
            size={24}
            disabled={state.status === 'loading'}
            onClick={load}
          >
            <RefreshCw />
          </IconButton>
        </div>
        {state.status === 'error' && (
          <StatusMessage tone="error">{state.message}</StatusMessage>
        )}
        {state.status === 'loading' && (
          <StatusMessage tone="loading">
            Reading MCP configuration…
          </StatusMessage>
        )}
        {list && (
          <>
            {!native && (
              <StatusMessage tone="warning">
                Update this host to inherit provider configuration.
              </StatusMessage>
            )}
            {native && readOnly && (
              <StatusMessage role="note">
                MCP servers and hooks are paused in{' '}
                {modeLabel(provider, 'read-only')} mode.
              </StatusMessage>
            )}
            <div role="group" aria-label="Configured MCP servers">
              {list.servers.length === 0 && (
                <StatusMessage>
                  No MCP servers found in the inspected configuration.
                </StatusMessage>
              )}
              {list.servers.map(server => (
                <ListRow
                  key={server.key}
                  density="two-line"
                  size="sm"
                  title={server.name}
                  description={
                    scopeLabels[server.scope] +
                    ' · ' +
                    (server.transport
                      ? transportLabels[server.transport]
                      : 'Unknown transport') +
                    (server.problem ? ' · ' + server.problem : '')
                  }
                />
              ))}
              {list.issues.map(issue => (
                <StatusMessage key={issue} tone="warning">
                  {issue}
                </StatusMessage>
              ))}
            </div>
            {native && (
              <>
                <Separator />
                <ListRow
                  size="sm"
                  title="User hooks"
                  trailing={readOnly ? 'Inactive' : 'Follow provider settings'}
                />
              </>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
