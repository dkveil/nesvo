import { createHmac, randomUUID } from 'node:crypto';
import { ruleFileFingerprints } from '../inbox-rules/files';
import { SessionError } from '../sessions/session-error';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  hasRepositoryMarker,
  inspectRepositoryIdentity,
} from '../repositories/identity';
import { RepositoryTrustStore } from '../repositories/trust-store';
import {
  MCP_SERVER_NAME_PATTERN,
  mcpLimits,
  mcpReviewBytes,
  type McpRepositoryDefinition,
  type McpServerList,
  type Provider,
  type Session,
  type TrustRepositoryMcpInput,
} from '@nesvo/contracts';
import { claudeServer, readClaudeConfiguration } from './claude-servers';
import { codexServer, readCodexConfiguration } from './codex-servers';
import { hookLaunches, reviewText, serverLaunch } from './repository-details';
import { reviewRepositorySources } from './repository-source';
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
  projectSettings: boolean;
};
export type VerifyMcpTurn = () => Promise<TurnPolicy>;
export type RawMcpReviewInput = { sessionId: string | null; rawFor: string };

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
    ...previous.flatMap(({ id, name, detail, launches }) =>
      currentIds.has(id)
        ? []
        : [
            {
              id,
              name: reviewText(name),
              detail,
              launches,
              change: 'removed' as const,
            },
          ],
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
  readonly repositoryTrust: RepositoryTrustStore;

  constructor(private readonly database: DatabaseSync) {
    this.repositoryTrust = new RepositoryTrustStore(database);
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
    const configuration = await read(
      folders,
      issues,
      projectIssues,
      signal,
      profileDirectory,
    );
    const { userServers, userHooks, layers, sources } = configuration;
    const userEntries = Object.entries(userServers).map(([name, config]) =>
      describe(name, config, 'user'),
    );
    const projectEntries = new Map<string, ReturnType<typeof describe>>();
    const definitions: Definition[] = [];
    const effectiveServerIds = new Map<string, string>();
    let reviewBytes = 0;
    const addDefinition = (
      id: string,
      name: string,
      detail: string,
      config: unknown,
      launches?: Definition['launches'],
    ) => {
      if (definitions.length >= mcpLimits.listed) {
        projectIssues.push(
          'The repository has too many MCP servers and hooks to review.',
        );
        return;
      }
      try {
        if (launches) {
          reviewBytes += Buffer.byteLength(JSON.stringify(launches));
          if (reviewBytes > mcpReviewBytes) {
            projectIssues.push(
              'The repository MCP and hook details are too large to review.',
            );
            launches = undefined;
          }
        }
        definitions.push({
          id: id.length <= 400 ? id : 'definition:' + this.fingerprint(id),
          name: reviewText(name).slice(0, 300),
          detail: detail.slice(0, mcpLimits.summary),
          ...(launches ? { launches } : {}),
          hash: this.fingerprint(
            /(?:^|:)local(?:$|:|-)/.test(id) || id.endsWith('hooks-disabled')
              ? [repository, config]
              : config,
          ),
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
    if ('instructions' in configuration)
      for (const instruction of configuration.instructions)
        addDefinition(
          instruction.id,
          instruction.name,
          instruction.detail,
          instruction.config,
        );
    const inboxRules = await ruleFileFingerprints(
      folders.at(-1)!,
      signal ?? new AbortController().signal,
    );
    if (inboxRules.unreadable)
      projectIssues.push('A repository Inbox rule file cannot be read.');
    for (const rule of inboxRules.files)
      addDefinition(
        `inbox-rule:${rule.name}`,
        `Inbox rule ${rule.name}`,
        `Inbox rule · ${rule.bytes} bytes`,
        { inboxRule: rule.hash },
      );
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
          const definitionId = `${index}:${scope}:server:${name}`;
          effectiveServerIds.set(name, definitionId);
          addDefinition(
            definitionId,
            name || '?',
            `${scope === 'project' ? 'Project' : 'Local'} MCP server · ${entry.transport ?? 'Unknown transport'}`,
            config,
            serverLaunch(config, directory),
          );
        }
      for (const [scope, hooks] of [
        ['project', layer.hooks],
        ['local', layer.localHooks],
      ] as const) {
        hookSources.push(hooks);
        for (const [event, groups] of Object.entries(hooks)) {
          addDefinition(
            `${index}:${scope}:hook:${event}`,
            event || '?',
            `${scope === 'project' ? 'Project' : 'Local'} hooks`,
            groups,
            hookLaunches(groups, directory),
          );
        }
      }
      for (const extra of 'extras' in layer ? layer.extras : [])
        addDefinition(
          `${index}:${extra.id}`,
          extra.name,
          extra.detail,
          extra.config,
          extra.launches,
        );
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
    const legacyFingerprint = this.fingerprint([
      repository,
      definitions.map(({ id, hash }) => [id, hash]),
    ]);
    const stored = this.database
      .prepare(
        'SELECT fingerprint, definitions, trusted FROM mcp_repository_trust WHERE provider = ? AND repository = ?',
      )
      .get(provider, repository) as StoredTrust | undefined;
    const legacyTrusted =
      !projectIssues.length &&
      stored?.trusted === 1 &&
      stored.fingerprint === legacyFingerprint;
    if (stored?.trusted === 1 && !legacyTrusted)
      this.database
        .prepare(
          'UPDATE mcp_repository_trust SET trusted = 0 WHERE provider = ? AND repository = ?',
        )
        .run(provider, repository);
    const marker = await hasRepositoryMarker(folders.at(-1)!);
    const identity = marker
      ? await inspectRepositoryIdentity(
          folders.at(-1)!,
          signal ?? new AbortController().signal,
        )
      : { status: 'unverified' as const, root: folders.at(-1)! };
    const fingerprint = this.fingerprint([
      legacyFingerprint,
      identity.status,
      'gitDirectory' in identity ? directoryKey(identity.gitDirectory) : null,
      'remote' in identity ? identity.remote : null,
    ]);
    if (legacyTrusted && stored) {
      const previous: unknown = JSON.parse(stored.definitions);
      if (Array.isArray(previous))
        this.repositoryTrust.migrate(
          {
            identity,
            sessionId: null,
            provider,
            fingerprint,
            definitions: definitions.map(({ id, hash }) => [id, hash]),
          },
          repository,
          previous,
        );
    }
    const identityPolicy = this.repositoryTrust.resolve(identity, provider);
    const approved =
      identityPolicy.state === 'eligible'
        ? identityPolicy.definitions
        : new Map<string, string>();
    const managed = marker && identityPolicy.state !== 'none';
    const trustedLegacySource = legacyTrusted && !managed;
    const hasApproval = (definition: Definition) =>
      approved.get(definition.id) === definition.hash;
    const isAdvisory = (definition: Definition) =>
      /:(?:skills|commands)$/.test(definition.id);
    const trusted =
      trustedLegacySource ||
      (identityPolicy.state === 'eligible' &&
        !projectIssues.length &&
        definitions.every(
          definition => isAdvisory(definition) || hasApproval(definition),
        ));
    const previous = managed
      ? [...approved].map(([id, hash]) => ({
          id,
          hash,
          name:
            definitions.find(definition => definition.id === id)?.name ??
            reviewText(id),
          detail: 'Previously reviewed repository definition',
        }))
      : stored
        ? (JSON.parse(stored.definitions) as Definition[])
        : [];
    const eligibleServers: ConfigTable = Object.fromEntries(
      claude && managed && !projectIssues.length
        ? Object.entries(projectServers).filter(([name, definition]) => {
            const digest = definitions.find(
              item => item.id === effectiveServerIds.get(name),
            );
            if (
              !digest ||
              !hasApproval(digest) ||
              !definition ||
              typeof definition !== 'object'
            )
              return false;
            const transport = (definition as ConfigTable).type;
            return transport === 'http' || transport === 'sse';
          })
        : [],
    );
    if (identity.status === 'ambiguous' || identityPolicy.state === 'ambiguous')
      issues.push(
        'Resolve the competing repository remotes or trust patterns before approving definitions.',
      );
    if (managed)
      issues.push(
        'Native repository settings, hooks and command-based servers are held. This provider needs a verified isolated loading path for those definitions.',
      );
    const list: McpServerList = {
      provider,
      configuration: 'native',
      servers: [...userEntries, ...projectEntries.values()].slice(
        0,
        mcpLimits.listed,
      ),
      issues: [
        ...new Set(
          [...projectIssues, ...issues].map(issue =>
            reviewText(issue).slice(0, mcpLimits.problem),
          ),
        ),
      ].slice(0, mcpLimits.issues),
      repository: {
        name: reviewText(basename(folders.at(-1)!) || folders.at(-1)!).slice(
          0,
          4096,
        ),
        status:
          projectIssues.length ||
          identity.status === 'ambiguous' ||
          (managed && identity.status === 'unverified')
            ? 'unavailable'
            : trusted
              ? 'trusted'
              : definitions.length
                ? 'needs-trust'
                : 'empty',
        fingerprint,
        changed:
          previous.length > 0 &&
          (definitions.length !== previous.length ||
            definitions.some(
              definition =>
                !previous.some(
                  entry =>
                    entry.id === definition.id &&
                    entry.hash === definition.hash,
                ),
            )),
        identity,
        identityRule: identityPolicy.state,
        safeLoading: Object.keys(eligibleServers).length
          ? 'mcp-snapshot'
          : 'isolated',
        definitions: definitionChanges(definitions, previous).map(
          definition => {
            if (!managed || definition.change === 'removed') return definition;
            const source = definitions.find(
              entry => entry.id === definition.id,
            )!;
            return {
              ...definition,
              approval: isAdvisory(source)
                ? 'advisory'
                : hasApproval(source)
                  ? 'approved'
                  : 'withheld',
            };
          },
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
      projectServers: trustedLegacySource ? projectServers : eligibleServers,
      projectHooks: trustedLegacySource ? projectHooks : {},
      projectDisablesHooks: trustedLegacySource && projectDisablesHooks,
      projectSettings: claude && trustedLegacySource,
    };
    const userFingerprint = this.fingerprint([userServers, userHooks, issues]);
    return {
      list,
      repository,
      definitions,
      fingerprint,
      legacyFingerprint,
      managed,
      identity,
      userFingerprint,
      policy,
      sources,
    };
  }

  async repositoryStatus(
    provider: Provider,
    directory: string,
    signal?: AbortSignal,
  ) {
    const snapshot = await this.inspect(provider, directory, signal);
    return snapshot.managed
      ? 'needs-trust'
      : (snapshot.list.repository?.status ?? 'empty');
  }

  async connectionInventory(
    provider: Provider,
    directory: string,
    signal: AbortSignal,
    profileDirectory?: string,
    includeRepository = false,
  ) {
    const { list, policy } = await this.inspect(
      provider,
      directory,
      signal,
      profileDirectory,
    );
    const candidates = list.servers.filter(
      server => server.scope === 'user' || includeRepository,
    );
    const servers = candidates.filter(
      server =>
        !server.problem &&
        /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/.test(server.name) &&
        candidates.filter(candidate => candidate.name === server.name)
          .length === 1 &&
        (server.scope === 'user' ||
          (includeRepository &&
            Object.hasOwn(policy.projectServers, server.name))),
    );
    return {
      candidates,
      servers,
      definitions: Object.fromEntries(
        servers.map(server => [
          server.name,
          (server.scope === 'user' ? policy.servers : policy.projectServers)[
            server.name
          ],
        ]),
      ),
    };
  }

  async list(
    provider: Provider,
    directory: string,
    signal?: AbortSignal,
    profileDirectory?: string,
    raw?: RawMcpReviewInput,
  ) {
    const snapshot = await this.inspect(
      provider,
      directory,
      signal,
      profileDirectory,
    );
    if (!raw) return snapshot.list;
    const repository = snapshot.list.repository!;
    if (
      repository.fingerprint !== raw.rawFor ||
      repository.status === 'unavailable'
    )
      throw new SessionError(
        'invalid-request',
        'Repository definitions changed or are unavailable. Review the current configuration.',
      );
    const files = reviewRepositorySources(snapshot.sources);
    if (!files)
      throw new SessionError(
        'unavailable',
        'The repository source definitions could not be displayed within the review size limit.',
      );
    repository.rawReview = {
      files,
      token: this.rawReviewToken(
        provider,
        snapshot.repository,
        raw.sessionId,
        raw.rawFor,
      ),
    };
    return snapshot.list;
  }

  private rawReviewToken(
    provider: Provider,
    repository: string,
    sessionId: string | null,
    fingerprint: string,
  ) {
    return this.fingerprint([
      'raw MCP review',
      provider,
      repository,
      sessionId,
      fingerprint,
    ]);
  }

  async trust(
    provider: Provider,
    directory: string,
    request: TrustRepositoryMcpInput,
    signal?: AbortSignal,
    profileDirectory?: string,
  ) {
    const { fingerprint, rawReviewToken, decision } = request;
    const sessionId = 'sessionId' in request ? request.sessionId : null;
    const snapshot = await this.inspect(
      provider,
      directory,
      signal,
      profileDirectory,
    );
    const status = snapshot.list.repository?.status;
    if (
      snapshot.fingerprint !== fingerprint ||
      (decision?.action !== 'defer' &&
        status !== 'needs-trust' &&
        status !== 'trusted' &&
        status !== 'empty')
    )
      throw new SessionError(
        'invalid-request',
        'Repository MCP servers or hooks changed. Review the current definitions.',
      );
    if (
      decision?.action !== 'defer' &&
      snapshot.definitions.some(definition =>
        definition.launches?.some(launch => launch.requiresRawReview),
      ) &&
      rawReviewToken !==
        this.rawReviewToken(
          provider,
          snapshot.repository,
          sessionId,
          fingerprint,
        )
    )
      throw new SessionError(
        'invalid-request',
        'Open the raw definitions before trusting this repository.',
      );
    if (decision) {
      this.repositoryTrust.decision(
        {
          identity: snapshot.identity,
          sessionId,
          provider,
          fingerprint,
          definitions: snapshot.definitions.map(({ id, hash }) => [id, hash]),
        },
        decision,
      );
    } else if (!snapshot.managed)
      this.database
        .prepare(
          'INSERT INTO mcp_repository_trust (provider, repository, fingerprint, definitions, trusted) VALUES (?, ?, ?, ?, 1) ON CONFLICT(provider, repository) DO UPDATE SET fingerprint = excluded.fingerprint, definitions = excluded.definitions, trusted = 1',
        )
        .run(
          provider,
          snapshot.repository,
          snapshot.legacyFingerprint,
          JSON.stringify(snapshot.definitions),
        );
    else
      throw new SessionError(
        'invalid-request',
        'Review this repository using the current repository trust rules.',
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
      const sameProject = current.fingerprint === before.fingerprint;
      return sameProject
        ? {
            ...current.policy,
            projectSettings:
              before.policy.projectSettings && current.policy.projectSettings,
            projectDisablesHooks:
              before.policy.projectDisablesHooks ||
              current.policy.projectDisablesHooks,
            projectHooks: Object.keys(before.policy.projectHooks).length
              ? current.policy.projectHooks
              : {},
            projectServers: Object.fromEntries(
              Object.entries(current.policy.projectServers).filter(([name]) =>
                Object.hasOwn(before.policy.projectServers, name),
              ),
            ),
          }
        : {
            ...current.policy,
            projectServers: {},
            projectHooks: {},
            projectDisablesHooks: false,
            projectSettings: false,
          };
    };
  }
}
