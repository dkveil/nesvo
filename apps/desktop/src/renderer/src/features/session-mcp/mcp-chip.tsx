import { useId, useRef, useState, type ReactNode } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  mcpServerNameOf,
  type ListMcpServersInput,
  type McpSelection,
  type McpServer,
  type McpServerList,
} from '@nesvo/contracts';
import { errorDetail, modeLabel, type Provider } from '@/entities/session';
import { ComposerChip } from '@/features/new-thread/composer-chip';
import { IconButton } from '@/shared/ui/icon-button';
import { Label } from '@/shared/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { Hint } from '@/shared/ui/tooltip';
import { scopeLabels, transportLabels } from './mcp-labels';

type Props = {
  hostId: string;
  provider: Provider;
  target: ListMcpServersInput;
  selection: McpSelection;
  readOnly: boolean;
  disabled: boolean;
  unsupported?: boolean;
  lockedReason?: string;
  onChange: (selection: McpSelection) => void;
};

type ListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; list: McpServerList };

type ToggleRowProps = {
  id: string;
  label: string;
  detail?: ReactNode;
  problem?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  serverKey?: string;
};

const hookSources: Record<Provider, string> = {
  'Claude Code': 'Runs the hooks from your Claude Code settings.',
  Codex: 'Runs the hooks from your Codex configuration.',
};

function serverDetail(server: McpServer) {
  return [
    scopeLabels[server.scope],
    server.transport ? transportLabels[server.transport] : null,
    server.summary,
  ]
    .filter(Boolean)
    .join(' · ');
}

function ToggleRow({
  id,
  label,
  detail,
  problem,
  checked,
  disabled,
  onCheckedChange,
  className,
  serverKey,
}: ToggleRowProps) {
  return (
    <div
      data-mcp-server={serverKey}
      className={cn('flex items-start gap-2.5 px-2 py-1.5', className)}
    >
      <span className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id} className="block truncate">
          {label}
        </Label>
        {detail && (
          <span className="block truncate text-2xs text-muted-foreground">
            {detail}
          </span>
        )}
        {problem && <StatusMessage tone="warning">{problem}</StatusMessage>}
      </span>
      <Switch
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function McpChip({
  hostId,
  provider,
  target,
  selection,
  readOnly,
  disabled,
  unsupported = false,
  lockedReason = '',
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ListState>({ status: 'idle' });
  const request = useRef(0);
  const idPrefix = useId();
  const load = () => {
    const current = ++request.current;
    setState({ status: 'loading' });
    window.nesvo.listMcpServers(target, hostId).then(
      list => {
        if (current === request.current) setState({ status: 'loaded', list });
      },
      failure => {
        if (current === request.current)
          setState({
            status: 'error',
            message: `Could not read MCP servers. ${errorDetail(failure)}`,
          });
      },
    );
  };
  const list = state.status === 'loaded' ? state.list : null;
  const listed = new Set(list?.servers.map(server => server.key));
  const missing = list ? selection.servers.filter(key => !listed.has(key)) : [];
  const locked = disabled || !!lockedReason;
  const toggleServer = (key: string, enabled: boolean) => {
    const name = mcpServerNameOf(key);
    const servers = enabled
      ? [
          ...selection.servers.filter(item => mcpServerNameOf(item) !== name),
          key,
        ]
      : selection.servers.filter(item => item !== key);
    onChange({ ...selection, servers });
  };
  const count = selection.servers.length;
  const active = count > 0 || selection.hooks;
  const readOnlyMode = modeLabel(provider, 'read-only');
  const label = [
    'MCP',
    count ? String(count) : null,
    selection.hooks ? 'hooks' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const hint = unsupported
    ? 'Update the host to use MCP servers and hooks'
    : lockedReason ||
      (readOnly && active
        ? `Not available in ${readOnlyMode} mode`
        : 'MCP servers and hooks');
  return (
    <Popover
      open={open && !unsupported}
      onOpenChange={next => {
        setOpen(next);
        if (next) load();
      }}
    >
      <Hint label={hint}>
        <PopoverTrigger asChild>
          <ComposerChip
            disabled={disabled || unsupported}
            aria-label={`${label}. ${hint}`}
            data-session-mcp={selection.servers.join(' ')}
            icon={<Plug aria-hidden="true" />}
            className={cn(
              active && !readOnly && 'text-foreground',
              active && readOnly && 'line-through',
            )}
          >
            <span>{label}</span>
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
          <p className="text-xs font-medium text-muted-foreground">
            Applies from the next turn
          </p>
          <IconButton
            label="Refresh"
            size={24}
            disabled={state.status === 'loading'}
            onClick={load}
          >
            <RefreshCw
              className={cn(
                state.status === 'loading' &&
                  'animate-spin motion-reduce:animate-none',
              )}
            />
          </IconButton>
        </div>
        {readOnly && (
          <StatusMessage tone="warning" variant="notice" role="note">
            {`Not available in ${readOnlyMode} mode. The selection applies when the session can edit.`}
          </StatusMessage>
        )}
        {lockedReason && (
          <StatusMessage role="note" className="px-1">
            {lockedReason}.
          </StatusMessage>
        )}
        {state.status === 'error' && (
          <StatusMessage tone="error" className="px-1">
            {state.message}
          </StatusMessage>
        )}
        {state.status === 'loading' && !list && (
          <StatusMessage tone="loading" className="px-1">
            Reading MCP servers…
          </StatusMessage>
        )}
        {list && (
          <div role="group" aria-label="MCP servers" className="space-y-0.5">
            {list.servers.length === 0 && missing.length === 0 && (
              <StatusMessage className="px-2 py-1">
                {`No MCP servers are configured for ${provider} on this computer.`}
              </StatusMessage>
            )}
            {list.servers.map((server, index) => {
              const checked = selection.servers.includes(server.key);
              return (
                <ToggleRow
                  key={server.key}
                  serverKey={server.key}
                  id={`${idPrefix}-server-${index}`}
                  label={server.name}
                  detail={serverDetail(server)}
                  problem={server.problem ?? undefined}
                  checked={checked}
                  disabled={locked || (!checked && !!server.problem)}
                  onCheckedChange={value => toggleServer(server.key, value)}
                />
              );
            })}
            {missing.map((key, index) => (
              <ToggleRow
                key={key}
                serverKey={key}
                id={`${idPrefix}-missing-${index}`}
                label={mcpServerNameOf(key)}
                problem="No longer configured. Turn it off to start the next turn."
                checked
                disabled={locked}
                onCheckedChange={() => toggleServer(key, false)}
              />
            ))}
            {list.issues.map(issue => (
              <StatusMessage key={issue} tone="warning" className="px-2">
                {issue}
              </StatusMessage>
            ))}
          </div>
        )}
        <ToggleRow
          id={`${idPrefix}-hooks`}
          label="Use my hooks"
          detail={hookSources[provider]}
          checked={selection.hooks}
          disabled={locked}
          onCheckedChange={hooks => onChange({ ...selection, hooks })}
          className="border-t pt-2.5"
        />
      </PopoverContent>
    </Popover>
  );
}
