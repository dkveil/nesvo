import { createHmac, randomUUID } from 'node:crypto';
import { SessionError } from '../sessions/session-error';
import { basename, win32 } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  MCP_SERVER_NAME_PATTERN,
  mcpLimits,
  type McpRepositoryDefinition,
  type McpServerList,
  type Provider,
  type Session,
} from '@nesvo/contracts';
import { claudeServer, readClaudeConfiguration } from './claude-servers';
import { codexServer, readCodexConfiguration } from './codex-servers';
import {
  directoryKey,
  mergeHooks,
  repositoryFolders,
  type ConfigTable,
} from './scoped-config';

type Definition = Omit<McpRepositoryDefinition, 'change'> & { hash: string };
type TurnPolicy = {
  servers: ConfigTable;
  projectServers: ConfigTable;
  projectHooks: ConfigTable;
  projectDisablesHooks: boolean;
};
export type VerifyMcpTurn = () => Promise<TurnPolicy>;

export const interactiveMcpSession = (session: Session) =>
  !session.parentId &&
  session.role !== 'worker' &&
  !session.scheduledJobId &&
  !session.workflowRunId &&
  !session.workflowStepId;

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('An MCP definition is too deeply nested.');
  if (Array.isArray(value))
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) !== null &&
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('An MCP definition contains an unsupported value.');
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('An MCP definition contains an unsupported number.');
    return JSON.stringify(value);
  }
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => JSON.stringify(key) + ':' + canonical(item, depth + 1),
      )
      .join(',') +
    '}'
  );
}

function executableName(command: unknown) {
  if (typeof command !== 'string') return '';
  const first = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command.trim());
  const name = win32.basename(first?.[1] ?? first?.[2] ?? first?.[3] ?? '');
  return /^[a-zA-Z0-9._-]{1,70}$/.test(name) ? name : '';
}

function serverDetail(config: unknown) {
  if (!config || typeof config !== 'object' || !('command' in config))
    return '';
  const executable = executableName(config.command);
  const count =
    'args' in config && Array.isArray(config.args) ? config.args.length : 0;
  return [
    executable,
    count === 0 ? '' : count + (count === 1 ? ' argument' : ' arguments'),
  ]
    .filter(Boolean)
    .join(' ? ');
}

function hookDetail(groups: unknown) {
  if (!Array.isArray(groups)) return '';
  const handlers = groups.flatMap(group =>
    Array.isArray(group?.hooks) ? group.hooks : [],
  );
  return [
    ...new Set(
      handlers.map(handler => executableName(handler?.command)).filter(Boolean),
    ),
  ]
    .slice(0, 3)
    .join(', ');
}

function definitionChanges(current: Definition[], previous: Definition[]) {
  const earlier = new Map(previous.map(item => [item.id, item.hash]));
  const currentIds = new Set(current.map(item => item.id));
  return [
    ...current.map(({ hash, ...definition }) => ({
      ...definition,
      change:
        earlier.size === 0
          ? null
          : !earlier.has(definition.id)
            ? ('added' as const)
            : earlier.get(definition.id) !== hash
              ? ('changed' as const)
              : null,
    })),
    ...previous.flatMap(({ id, name, detail }) =>
      currentIds.has(id)
        ? []
        : [{ id, name, detail, change: 'removed' as const }],
    ),
  ];
}

type StoredTrust = {
  fingerprint: string;
  definitions: string;
  trusted: number;
};

export class McpPolicy {
  private readonly key: string;

  constructor(private readonly database: DatabaseSync) {
    database
      .prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)')
      .run('mcp_trust_key', randomUUID());
    this.key = String(
      database
        .prepare('SELECT value FROM metadata WHERE key = ?')
        .get('mcp_trust_key')!.value,
    );
  }

  private fingerprint(value: unknown) {
    return createHmac('sha256', this.key)
      .update(canonical(value))
      .digest('hex');
  }

  private async inspect(
    provider: Provider,
    directory: string,
    signal?: AbortSignal,
    profileDirectory?: string,
  ) {
    const folders = await repositoryFolders(directory);
    const repository = directoryKey(folders.at(-1)!);
    const issues: string[] = [];
    const projectIssues: string[] = [];
    const claude = provider === 'Claude Code';
    const read = claude ? readClaudeConfiguration : readCodexConfiguration;
    const describe = claude ? claudeServer : codexServer;
    const { userServers, userHooks, layers } = await read(
      folders,
      issues,
      projectIssues,
      signal,
      profileDirectory,
    );
    const userEntries = Object.entries(userServers).map(([name, config]) =>
      describe(name, config, 'user'),
    );
    const projectEntries = new Map<string, ReturnType<typeof describe>>();
    const definitions: Definition[] = [];
    const addDefinition = (
      id: string,
      name: string,
      detail: string,
      config: unknown,
    ) => {
      if (definitions.length >= mcpLimits.listed) {
        projectIssues.push(
          'The repository has too many MCP servers and hooks to review.',
        );
        return;
      }
      try {
        definitions.push({
          id: id.length <= 400 ? id : 'definition:' + this.fingerprint(id),
          name: name.slice(0, 300),
          detail: detail.slice(0, mcpLimits.summary),
          hash: this.fingerprint(config),
        });
      } catch {
        projectIssues.push(
          'A repository MCP server or hook definition is unsupported.',
        );
      }
    };
    const projectServers: ConfigTable = Object.create(null);
    const hookSources: ConfigTable[] = [];
    let projectDisablesHooks = false;
    for (const [index, layer] of layers.entries()) {
      for (const [scope, servers] of [
        ['project', layer.servers],
        ['local', layer.localServers],
      ] as const)
        for (const [name, config] of Object.entries(servers)) {
          const entry = describe(name, config, scope);
          projectEntries.set(entry.key, entry);
          if (
            !MCP_SERVER_NAME_PATTERN.test(name) ||
            (entry.problem &&
              (claude || (config as ConfigTable | null)?.enabled !== false))
          )
            projectIssues.push(
              'A repository MCP server definition is unsupported.',
            );
          projectServers[name] = config;
          const launch = serverDetail(config);
          addDefinition(
            `${index}:${scope}:server:${name}`,
            name || '?',
            `${scope === 'project' ? 'Project' : 'Local'} MCP server · ${entry.transport ?? 'Unknown transport'}${launch ? ' · ' + launch : ''}`,
            config,
          );
        }
      for (const [scope, hooks] of [
        ['project', layer.hooks],
        ['local', layer.localHooks],
      ] as const) {
        hookSources.push(hooks);
        for (const [event, groups] of Object.entries(hooks)) {
          const launch = hookDetail(groups);
          addDefinition(
            `${index}:${scope}:hook:${event}`,
            event || '?',
            `${scope === 'project' ? 'Project' : 'Local'} hooks${launch ? ' · ' + launch : ''}`,
            groups,
          );
        }
      }
      projectDisablesHooks ||= layer.hooksDisabled;
      if (layer.hooksDisabled)
        addDefinition(
          `${index}:hooks-disabled`,
          'Disable hooks',
          'Repository hook setting',
          true,
        );
    }
    let projectHooks: ConfigTable = {};
    try {
      projectHooks = mergeHooks(hookSources);
    } catch {
      projectIssues.push('The repository hook definitions are invalid.');
    }
    definitions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const fingerprint = this.fingerprint([
      repository,
      definitions.map(({ id, hash }) => [id, hash]),
    ]);
    const stored = this.database
      .prepare(
        'SELECT fingerprint, definitions, trusted FROM mcp_repository_trust WHERE provider = ? AND repository = ?',
      )
      .get(provider, repository) as StoredTrust | undefined;
    const trusted =
      !projectIssues.length &&
      stored?.trusted === 1 &&
      stored.fingerprint === fingerprint;
    if (stored?.trusted === 1 && !trusted)
      this.database
        .prepare(
          'UPDATE mcp_repository_trust SET trusted = 0 WHERE provider = ? AND repository = ?',
        )
        .run(provider, repository);
    const previous = stored
      ? (JSON.parse(stored.definitions) as Definition[])
      : [];
    const list: McpServerList = {
      provider,
      configuration: 'native',
      servers: [...userEntries, ...projectEntries.values()].slice(
        0,
        mcpLimits.listed,
      ),
      issues: [...new Set([...issues, ...projectIssues])].slice(
        0,
        mcpLimits.issues,
      ),
      repository: {
        name: basename(folders.at(-1)!) || folders.at(-1)!,
        status: projectIssues.length
          ? 'unavailable'
          : trusted
            ? 'trusted'
            : definitions.length
              ? 'needs-trust'
              : 'empty',
        fingerprint,
        changed: !!stored && (!trusted || stored.fingerprint !== fingerprint),
        definitions: definitionChanges(definitions, previous).slice(
          0,
          mcpLimits.listed,
        ),
      },
    };
    const servers = Object.fromEntries(
      userEntries.flatMap(entry =>
        claude && entry.problem ? [] : [[entry.name, userServers[entry.name]]],
      ),
    );
    const policy: TurnPolicy = {
      servers,
      projectServers: trusted ? projectServers : {},
      projectHooks: trusted ? projectHooks : {},
      projectDisablesHooks: trusted && projectDisablesHooks,
    };
    const userFingerprint = this.fingerprint([userServers, userHooks, issues]);
    return {
      list,
      repository,
      definitions,
      fingerprint,
      userFingerprint,
      policy,
    };
  }

  async list(
    provider: Provider,
    directory: string,
    signal?: AbortSignal,
    profileDirectory?: string,
  ) {
    return (await this.inspect(provider, directory, signal, profileDirectory))
      .list;
  }

  async trust(
    provider: Provider,
    directory: string,
    fingerprint: string,
    signal?: AbortSignal,
    profileDirectory?: string,
  ) {
    const snapshot = await this.inspect(
      provider,
      directory,
      signal,
      profileDirectory,
    );
    const status = snapshot.list.repository?.status;
    if (
      snapshot.fingerprint !== fingerprint ||
      (status !== 'needs-trust' && status !== 'trusted')
    )
      throw new SessionError(
        'invalid-request',
        'Repository MCP servers or hooks changed. Review the current definitions.',
      );
    this.database
      .prepare(
        'INSERT INTO mcp_repository_trust (provider, repository, fingerprint, definitions, trusted) VALUES (?, ?, ?, ?, 1) ON CONFLICT(provider, repository) DO UPDATE SET fingerprint = excluded.fingerprint, definitions = excluded.definitions, trusted = 1',
      )
      .run(
        provider,
        snapshot.repository,
        fingerprint,
        JSON.stringify(snapshot.definitions),
      );
    return (await this.inspect(provider, directory, signal, profileDirectory))
      .list;
  }

  async prepare(
    provider: Provider,
    directory: string,
    signal: AbortSignal,
    profileDirectory?: string,
  ): Promise<VerifyMcpTurn> {
    const before = await this.inspect(
      provider,
      directory,
      signal,
      profileDirectory,
    );
    return async () => {
      const current = await this.inspect(
        provider,
        directory,
        signal,
        profileDirectory,
      );
      if (current.userFingerprint !== before.userFingerprint)
        throw new Error(
          'User MCP servers or hooks changed while preparing the turn. Send the message again.',
        );
      const sameProject =
        current.fingerprint === before.fingerprint &&
        before.list.repository?.status === 'trusted';
      return sameProject
        ? current.policy
        : {
            ...current.policy,
            projectServers: {},
            projectHooks: {},
            projectDisablesHooks: false,
          };
    };
  }
}
