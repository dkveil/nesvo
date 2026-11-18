import type { DesktopApi } from '@nesvo/contracts';
import {
  ProviderGlyph,
  providers,
  providerUsable,
  type ProviderStates,
} from '@/entities/session';
import { Badge } from '@/shared/ui/badge';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  useProviderSetup,
  type ProviderSetupReport,
} from './use-provider-setup';

type Props = {
  api: Pick<DesktopApi, 'listMcpServers' | 'discoverSkills'>;
  hostId: string;
  directory: string;
  statuses: ProviderStates;
};

const SHOWN_SERVERS = 6;

function ProviderReport({ report }: { report: ProviderSetupReport }) {
  const servers = report.servers?.servers ?? [];
  const repository = report.servers?.repository;
  const skills = report.skills?.skills ?? [];
  return (
    <li
      aria-label={report.provider}
      data-onboarding-setup={report.provider}
      className="space-y-2 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <ProviderGlyph
          provider={report.provider}
          className="size-4 text-muted-foreground"
        />
        <p className="min-w-0 flex-1 truncate text-ui font-medium">
          {report.provider}
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">
          {report.skills
            ? `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}${report.skills.truncated ? '+' : ''}`
            : 'Skills unavailable'}
        </span>
      </div>
      {report.servers && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {servers.length
              ? `MCP servers (${servers.length})`
              : 'No MCP servers configured'}
          </p>
          {servers.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="MCP servers">
              {servers.slice(0, SHOWN_SERVERS).map(server => (
                <li key={server.key}>
                  <Badge tone="neutral" appearance="outline">
                    {server.name}
                    <span className="text-muted-foreground">
                      {' '}
                      · {server.scope}
                    </span>
                  </Badge>
                </li>
              ))}
              {servers.length > SHOWN_SERVERS && (
                <li>
                  <Badge tone="neutral" appearance="outline">
                    +{servers.length - SHOWN_SERVERS} more
                  </Badge>
                </li>
              )}
            </ul>
          )}
          {repository && repository.definitions.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {repository.definitions.length} repository{' '}
              {repository.definitions.length === 1
                ? 'integration'
                : 'integrations'}{' '}
              (MCP servers and hooks) in {repository.name}, reviewed before
              first use.
            </p>
          )}
        </div>
      )}
      {report.error && (
        <StatusMessage tone="warning">{report.error}</StatusMessage>
      )}
    </li>
  );
}

export function SetupStep({ api, hostId, directory, statuses }: Props) {
  const reports = useProviderSetup(api, hostId, directory, statuses, true);
  const ready = providers.filter(provider =>
    providerUsable(statuses[provider]),
  );
  if (!ready.length)
    return (
      <StatusMessage tone="info" variant="notice">
        Set up Claude Code or Codex first to see its MCP servers, hooks and
        skills.
      </StatusMessage>
    );
  return (
    <div className="space-y-3">
      {reports ? (
        <ul className="divide-y rounded-surface border bg-card">
          {reports.map(report => (
            <ProviderReport key={report.provider} report={report} />
          ))}
        </ul>
      ) : (
        <StatusMessage tone="loading">Reading your setup…</StatusMessage>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Read from your provider configuration
        {directory ? ` for ${directory}` : ''}. Nesvo never changes it; user
        hooks run only in edit modes.
      </p>
    </div>
  );
}
