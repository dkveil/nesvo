import type { DesktopApi } from '@nesvo/contracts';
import {
  ProviderGlyph,
  providers,
  providerUsable,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Disclosure } from '@/shared/ui/disclosure';
import { WorkingRules } from './working-rules';
import { Badge } from '@/shared/ui/badge';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  useProviderSetup,
  type ProviderSetupReport,
} from './use-provider-setup';

type Props = {
  api: Pick<
    DesktopApi,
    'listMcpServers' | 'discoverSkills' | 'reviewWorkingRules'
  >;
  hostId: string;
  directory: string;
  statuses: ProviderStates;
  onSetupAgents: () => void;
};

const SHOWN_SERVERS = 4;

function ProviderReport({ report }: { report: ProviderSetupReport }) {
  const servers = report.servers?.servers ?? [];
  const repository = report.servers?.repository;
  const skills = report.skills?.skills ?? [];
  return (
    <li
      aria-label={report.provider}
      data-onboarding-setup={report.provider}
      className="min-w-0 space-y-2 rounded-surface border bg-card px-4 py-3"
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
            : 'Skills could not be read'}
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
                  <Badge
                    tone="neutral"
                    appearance="outline"
                    className="max-w-full"
                  >
                    <span className="max-w-32 truncate" title={server.name}>
                      {server.name}
                    </span>
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
      {report.serversError && (
        <StatusMessage tone="warning">
          MCP · {report.serversError}
        </StatusMessage>
      )}
      {skills.length > 0 && (
        <p
          className="truncate text-xs text-muted-foreground"
          title={skills
            .map(skill => skill.name)
            .slice(0, 8)
            .join(', ')}
        >
          {skills
            .slice(0, 4)
            .map(skill => skill.name)
            .join(', ')}
          {skills.length > 4 && ` · +${skills.length - 4} more`}
        </p>
      )}
      {report.skillsError && (
        <StatusMessage tone="warning">
          Skills · {report.skillsError}
        </StatusMessage>
      )}
      {!!report.skills?.issues.length && (
        <Disclosure
          title={
            skills.length
              ? 'Skill discovery details'
              : 'Why the catalog is incomplete'
          }
          className="-mx-1"
          contentClassName="max-h-24 overflow-y-auto break-words"
        >
          {report.skills.issues[0]?.message}
        </Disclosure>
      )}
    </li>
  );
}

export function SetupStep({
  api,
  hostId,
  directory,
  statuses,
  onSetupAgents,
}: Props) {
  const reports = useProviderSetup(api, hostId, directory, statuses);
  const ready = providers.filter(provider =>
    providerUsable(statuses[provider]),
  );
  return (
    <div className="space-y-3">
      {!ready.length ? (
        <div className="flex items-center justify-between gap-3 rounded-surface border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            Connect Claude Code or Codex to discover MCP servers and skills.
          </p>
          <Button variant="outline" onClick={onSetupAgents}>
            Set up agents
          </Button>
        </div>
      ) : reports ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {reports.map(report => (
            <ProviderReport key={report.provider} report={report} />
          ))}
        </ul>
      ) : (
        <StatusMessage tone="loading">Reading your setup…</StatusMessage>
      )}
      <WorkingRules
        api={api}
        directory={directory}
        statuses={statuses}
        onSetupAgents={onSetupAgents}
      />
    </div>
  );
}
