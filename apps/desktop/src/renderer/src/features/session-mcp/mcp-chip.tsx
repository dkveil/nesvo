import { useId, useRef, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import {
  mcpServerNameOf,
  type ListMcpServersInput,
  type McpSelection,
  type McpServer,
  type McpServerList,
} from '@nesvo/contracts';
import { errorDetail, modeLabel, type Provider } from '@/entities/session';
import { ComposerChip } from '@/features/new-thread/composer-chip';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Switch } from '@/shared/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
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
    <>
      <Popover
        open={open && !unsupported}
        onOpenChange={next => {
          setOpen(next);
          if (next) load();
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <ComposerChip
                disabled={disabled || unsupported}
                aria-label={`${label}. ${hint}`}
                data-session-mcp={selection.servers.join(' ')}
                className={cn(
                  active && !readOnly && 'text-foreground',
                  active && readOnly && 'line-through',
                )}
              >
                <Plug aria-hidden="true" />
                <span className="truncate">{label}</span>
              </ComposerChip>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{hint}</TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="MCP servers and hooks"
          className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 overflow-y-auto p-2.5"
        >
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="text-xs font-medium text-muted-foreground">
              Applies from the next turn
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6 text-muted-foreground"
              aria-label="Refresh"
              title="Refresh"
              disabled={state.status === 'loading'}
              onClick={load}
            >
              <RefreshCw
                className={cn(
                  'size-3.5',
                  state.status === 'loading' &&
                    'animate-spin motion-reduce:animate-none',
                )}
              />
            </Button>
          </div>
          {readOnly && (
            <p
              role="note"
              className="px-1 text-xs leading-5 text-warning-foreground"
            >
              {`Not available in ${readOnlyMode} mode. The selection applies when the session can edit.`}
            </p>
          )}
          {lockedReason && (
            <p role="note" className="px-1 text-xs text-muted-foreground">
              {lockedReason}.
            </p>
          )}
          {state.status === 'error' && (
            <p
              role="alert"
              className="px-1 text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {state.message}
            </p>
          )}
          {state.status === 'loading' && !list && (
            <p role="status" className="px-1 text-xs text-muted-foreground">
              Reading MCP servers…
            </p>
          )}
          {list && (
            <div role="group" aria-label="MCP servers" className="space-y-0.5">
              {list.servers.length === 0 && missing.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {`No MCP servers are configured for ${provider} on this computer.`}
                </p>
              )}
              {list.servers.map((server, index) => {
                const checked = selection.servers.includes(server.key);
                const switchId = `${idPrefix}-server-${index}`;
                return (
                  <div
                    key={server.key}
                    data-mcp-server={server.key}
                    className="flex items-start gap-2.5 rounded-md px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <label
                        htmlFor={switchId}
                        className="block truncate text-[13px] font-medium"
                      >
                        {server.name}
                      </label>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {serverDetail(server)}
                      </span>
                      {server.problem && (
                        <span className="mt-0.5 block text-2xs leading-4 text-warning-foreground [overflow-wrap:anywhere]">
                          {server.problem}
                        </span>
                      )}
                    </span>
                    <Switch
                      id={switchId}
                      className="mt-0.5"
                      checked={checked}
                      disabled={locked || (!checked && !!server.problem)}
                      onCheckedChange={value => toggleServer(server.key, value)}
                    />
                  </div>
                );
              })}
              {missing.map((key, index) => {
                const switchId = `${idPrefix}-missing-${index}`;
                return (
                  <div
                    key={key}
                    data-mcp-server={key}
                    className="flex items-start gap-2.5 rounded-md px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <label
                        htmlFor={switchId}
                        className="block truncate text-[13px] font-medium"
                      >
                        {mcpServerNameOf(key)}
                      </label>
                      <span className="mt-0.5 block text-2xs leading-4 text-warning-foreground">
                        No longer configured. Turn it off to start the next
                        turn.
                      </span>
                    </span>
                    <Switch
                      id={switchId}
                      className="mt-0.5"
                      checked
                      disabled={locked}
                      onCheckedChange={() => toggleServer(key, false)}
                    />
                  </div>
                );
              })}
              {list.issues.map(issue => (
                <p
                  key={issue}
                  role="alert"
                  className="px-2 text-2xs leading-4 text-warning-foreground"
                >
                  {issue}
                </p>
              ))}
            </div>
          )}
          <div className="flex items-start gap-2.5 border-t px-2 pt-2.5">
            <span className="min-w-0 flex-1">
              <label
                htmlFor={`${idPrefix}-hooks`}
                className="block text-[13px] font-medium"
              >
                Use my hooks
              </label>
              <span className="block text-2xs leading-4 text-muted-foreground">
                {hookSources[provider]}
              </span>
            </span>
            <Switch
              id={`${idPrefix}-hooks`}
              className="mt-0.5"
              checked={selection.hooks}
              disabled={locked}
              onCheckedChange={hooks => onChange({ ...selection, hooks })}
            />
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
