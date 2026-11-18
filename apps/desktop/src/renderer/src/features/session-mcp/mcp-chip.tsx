import { Plug, RefreshCw } from 'lucide-react';
import { modeLabel, type Provider } from '@/entities/session';
import { ComposerChip } from '@/features/new-thread/composer-chip';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Separator } from '@/shared/ui/separator';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import {
  McpConnectionFeedback,
  McpConnectionRows,
} from './mcp-connection-rows';
import {
  connectionLabels,
  connectionSummary,
  connectionTones,
} from './mcp-labels';
import type { McpConnections } from './use-mcp-connections';
import type { McpConfiguration } from './use-mcp-configuration';

type Props = {
  configuration: McpConfiguration;
  connections: McpConnections;
  provider: Provider;
  readOnly: boolean;
  isolated: boolean;
  disabled: boolean;
  unsupported: boolean;
  supportsTrust: boolean;
};

export function McpChip({
  configuration,
  connections,
  provider,
  readOnly,
  isolated,
  disabled,
  unsupported,
  supportsTrust,
}: Props) {
  const hint = unsupported
    ? 'Update the host to view MCP configuration'
    : 'MCP servers and hooks';
  const { list, loading, error } = configuration;
  const repository = list?.repository;
  const paused =
    repository?.status === 'needs-trust' ||
    repository?.status === 'unavailable';
  const readOnlyIsolation = readOnly && list?.readOnlyMcp !== 'approval';
  const pausedLabel =
    isolated || readOnlyIsolation
      ? 'MCP paused'
      : paused
        ? 'Repository MCP paused'
        : null;
  const status = connectionSummary(connections.list);
  const attentionTone =
    status === 'needs-authorization' || status === 'failed'
      ? connectionTones[status]
      : pausedLabel
        ? 'warning'
        : null;
  const detail = [pausedLabel, status && connectionLabels[status]]
    .filter(Boolean)
    .join('. ');
  const refresh = () => {
    void configuration.refresh();
    void connections.refresh();
  };
  return (
    <Popover
      onOpenChange={open => {
        if (open) refresh();
      }}
    >
      <Hint label={detail || hint}>
        <PopoverTrigger asChild>
          <ComposerChip
            disabled={disabled || unsupported}
            aria-label={hint}
            aria-description={detail || undefined}
            data-session-mcp=""
            icon={<Plug aria-hidden="true" />}
            size="sm"
            className="relative w-6 justify-center px-0"
          >
            {attentionTone && (
              <StatusDot
                tone={attentionTone}
                className="absolute top-0.5 right-0.5"
              />
            )}
          </ComposerChip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        aria-label="MCP servers and hooks"
        size="md"
        surface="solid"
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
            disabled={loading || connections.loading || !!connections.pending}
            onClick={refresh}
          >
            <RefreshCw />
          </IconButton>
        </div>
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        {loading && (
          <StatusMessage tone="loading">
            Reading MCP configuration…
          </StatusMessage>
        )}
        <McpConnectionFeedback connections={connections} />
        {!supportsTrust && (
          <StatusMessage tone="warning">
            Update this host to review repository MCP servers and hooks.
          </StatusMessage>
        )}
        {isolated ? (
          <StatusMessage>
            Workers and unattended turns run with MCP servers and hooks
            disabled.
          </StatusMessage>
        ) : readOnly && list ? (
          <StatusMessage>
            {readOnlyIsolation
              ? `MCP is isolated in ${modeLabel(provider, 'read-only')} because a one-time tool approval channel is unavailable.`
              : provider === 'Claude Code'
                ? 'Plan asks for MCP tool approval unless a saved allow rule matches.'
                : 'Each MCP tool call in Read-only requires a one-time approval.'}
          </StatusMessage>
        ) : null}
        {paused && (
          <StatusMessage tone="warning">
            Repository MCP servers and hooks are paused.
          </StatusMessage>
        )}
        {!isolated && paused && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={configuration.reopen}
          >
            Review repository configuration
          </Button>
        )}
        {list && (
          <>
            <div role="group" aria-label="Configured MCP servers">
              <McpConnectionRows
                servers={list.servers}
                connections={connections}
              />
              {list.issues.map(issue => (
                <StatusMessage key={issue} tone="warning">
                  {issue}
                </StatusMessage>
              ))}
            </div>
            <Separator />
            <ListRow
              size="sm"
              title="User hooks"
              trailing={
                isolated || readOnly ? 'Disabled' : 'Follow provider settings'
              }
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
