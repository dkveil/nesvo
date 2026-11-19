import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parse as parseToml } from 'smol-toml';
import {
  setupScanSchema,
  type SetupDetectionInput,
  type SetupFinding,
  type SetupScan,
  type SetupScanRequest,
} from '@nesvo/contracts';
import { readSmallInboxFile } from './external-inbox-client';
import {
  configurationText,
  ConfigurationRefusal,
} from './workflows/configuration-changes';
import type { SetupProfileService } from './setup-profile-service';

type Observation = Omit<SetupFinding, 'revision' | 'verifiedAt'> & {
  identity?: string;
};
type Baseline = {
  completed: boolean;
  revision: number;
  findings: Record<string, string>;
};
type FileSignal = { path: string; size: number; changed: number };
type LimitsEvidence = { available: boolean; count: number };

function digest(data: unknown) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

async function statFile(
  file: string,
  signal: AbortSignal,
): Promise<FileSignal | undefined> {
  signal.throwIfAborted();
  try {
    const status = await lstat(file);
    if (!status.isFile() || status.isSymbolicLink()) return;
    return { path: file, size: status.size, changed: status.mtimeMs };
  } catch {
    return;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function names(value: unknown) {
  return Object.keys(object(value))
    .filter(
      name =>
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/u.test(name) &&
        configurationText(name) === name,
    )
    .sort()
    .slice(0, 12);
}

async function metadata(file: string, signal: AbortSignal) {
  const status = await statFile(file, signal);
  if (!status || status.size > 128 * 1024) return;
  try {
    const document = await readSmallInboxFile(file, 128 * 1024);
    signal.throwIfAborted();
    return {
      value: object(
        file.endsWith('.toml') ? parseToml(document) : JSON.parse(document),
      ),
      identity: digest(status),
    };
  } catch {
    return;
  }
}

function staticConfigRoot(provider: 'claude' | 'codex', directory: string) {
  return (
    (provider === 'claude'
      ? process.env.CLAUDE_CONFIG_DIR
      : process.env.CODEX_HOME) ??
    join(
      process.env.NESVO_TEST_MODE === '1' ||
        process.env.NESVO_ISOLATED_PROFILE === '1'
        ? directory
        : homedir(),
      '.' + provider,
    )
  );
}

async function binary(name: 'claude' | 'codex', signal: AbortSignal) {
  const override =
    process.env.NESVO_TEST_MODE === '1'
      ? process.env[
          name === 'claude'
            ? 'NESVO_CLAUDE_EXECUTABLE'
            : 'NESVO_CODEX_EXECUTABLE'
        ]
      : undefined;
  const candidates = override
    ? [override]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .slice(0, 64)
        .flatMap(dir =>
          process.platform === 'win32'
            ? [join(dir, name + '.exe'), join(dir, name + '.cmd')]
            : [join(dir, name)],
        );
  for (const path of candidates) {
    signal.throwIfAborted();
    const resolved = await realpath(path).catch(() => undefined);
    if (!resolved) continue;
    const file = await statFile(resolved, signal);
    if (file) return file;
  }
}

async function providers(
  directory: string,
  signal: AbortSignal,
): Promise<Observation[]> {
  return (
    await Promise.all(
      (['claude', 'codex'] as const).map(async provider => {
        const label = provider === 'claude' ? 'Claude Code' : 'Codex';
        const root = staticConfigRoot(provider, directory);
        const paths =
          provider === 'claude'
            ? [join(root, '.claude.json'), join(root, 'settings.json')]
            : [join(root, 'config.toml')];
        const [executable, ...configs] = await Promise.all([
          binary(provider, signal),
          ...paths.map(path => metadata(path, signal)),
        ]);
        const findings: Observation[] = [
          {
            id: 'provider/' + provider,
            group: 'Providers',
            label,
            description: executable
              ? 'Executable found. Version, account and capabilities have not been verified in this scan.'
              : 'No executable was found in the inspected paths.',
            source: 'Detected',
            evidence: executable ? 'filesystem' : 'unavailable',
            readiness: executable ? 'partial' : 'unavailable',
            classification: 'observation',
            identity: executable ? digest(executable) : undefined,
          },
        ];
        for (const [index, config] of configs.entries()) {
          if (!config || !('value' in config)) continue;
          const servers = names(
            config.value[provider === 'claude' ? 'mcpServers' : 'mcp_servers'],
          );
          const hooks = names(config.value.hooks);
          if (!servers.length && !hooks.length) continue;
          findings.push({
            id: `configuration/${provider}/${index}`,
            group: 'Agent configuration',
            label: label + ' user configuration',
            description: [
              servers.length ? `MCP servers: ${servers.join(', ')}.` : '',
              hooks.length ? `Hook events: ${hooks.join(', ')}.` : '',
              'Runtime loading is unverified.',
            ]
              .filter(Boolean)
              .join(' ')
              .slice(0, 300),
            source: 'Detected',
            evidence: 'filesystem',
            readiness: 'withheld',
            classification: 'execution',
            identity: config.identity,
            action: 'review',
          });
        }
        return findings;
      }),
    )
  ).flat();
}

async function repoMetadata(
  directory: string | undefined,
  signal: AbortSignal,
) {
  if (!directory || !isAbsolute(directory)) return null;
  const root = await realpath(directory).catch(() => null);
  if (!root || relative(root, resolve(directory))) return null;
  signal.throwIfAborted();
  const git = await lstat(join(root, '.git')).catch(() => null);
  if (!git || git.isSymbolicLink() || (!git.isDirectory() && !git.isFile()))
    return null;
  return root;
}

const profileGroups: Record<string, SetupFinding['group']> = {
  worktrees: 'Worktrees and branches',
  recipes: 'Recipes',
  repositoryTrust: 'Repositories and trust',
  integrations: 'Agent configuration',
  externalMessages: 'Agent configuration',
  limits: 'Limits',
  automations: 'Recipes',
  github: 'GitHub',
};

export class SetupDetection {
  private readonly inFlight = new Map<string, Promise<SetupScan>>();
  private readonly cache = new Map<string, SetupScan>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly instanceId: string,
    private readonly directory: string,
    private readonly profile: SetupProfileService,
    private readonly counts: () => {
      repositories: number;
      usage: LimitsEvidence;
    },
    private readonly lifetime: AbortSignal,
  ) {}

  scan(input: SetupScanRequest): Promise<SetupScan> {
    const scope = input.directory ? resolve(input.directory) : '';
    const key = input.trigger + ':' + scope;
    const current = this.inFlight.get(key);
    if (current) return current;
    const previous = this.cache.get(scope);
    if (
      previous &&
      input.trigger === 'first-open' &&
      Date.now() - Date.parse(previous.scannedAt) < 30_000
    )
      return Promise.resolve(previous);
    if (this.inFlight.size >= 3)
      throw new ConfigurationRefusal(
        'busy',
        'Wait for the current setup scan to finish.',
      );
    const task = this.collect(input, scope).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, task);
    return task;
  }

  acknowledge(input: Extract<SetupDetectionInput, { action: 'acknowledge' }>) {
    const report = this.cache.get('');
    if (
      !report ||
      input.instanceId !== this.instanceId ||
      report.revision !== input.revision
    )
      throw new ConfigurationRefusal(
        'conflict',
        'The setup scan changed. Review the current computer again.',
      );
    const baseline: Baseline = {
      completed: report.completed || input.completed,
      revision: report.revision,
      findings: Object.fromEntries(
        report.findings.map(item => [item.id, item.revision]),
      ),
    };
    this.database
      .prepare(
        "INSERT INTO metadata (key, value) VALUES ('setup_review', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(baseline));
    const acknowledged = {
      ...report,
      changes: [],
      completed: baseline.completed,
      reviewedRevision: baseline.revision,
    };
    this.cache.set('', acknowledged);
    return acknowledged;
  }

  private nextRevision() {
    return Number(
      this.database
        .prepare(
          "INSERT INTO metadata (key, value) VALUES ('setup_scan_revision', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value",
        )
        .get()?.value,
    );
  }

  private async collect(input: SetupScanRequest, scope: string) {
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(2800)]);
    const time = new Date().toISOString();
    const observations: Observation[] = [];
    const { repositories, usage } = this.counts();
    const candidate = this.profile.inspect();
    const observed = (
      id: string,
      group: SetupFinding['group'],
      label: string,
      description: string,
      evidence: SetupFinding['evidence'] = 'unavailable',
      readiness: SetupFinding['readiness'] = 'not-checked',
    ) =>
      observations.push({
        id,
        group,
        label,
        description,
        evidence,
        readiness,
        source: 'Detected',
        classification: 'observation',
      });
    const scopeRoot = await repoMetadata(input.directory, signal).catch(
      () => null,
    );
    if (input.trigger !== 'startup' && input.trigger !== 'first-open') {
      const scanned = await providers(this.directory, signal).catch(() => []);
      observations.push(...scanned);
      if (!scanned.length)
        observed(
          'provider/partial',
          'Providers',
          'Provider inspection incomplete',
          'Refresh to retry the bounded filesystem scan.',
        );
    }
    if (!observations.some(item => item.group === 'Agent configuration'))
      observed(
        'configuration/unverified',
        'Agent configuration',
        'Hook and MCP loading',
        'Installed or declared integrations need local runtime review.',
      );
    if (scopeRoot) {
      observed(
        'repository/checkout',
        'Repositories and trust',
        'Checkout metadata found',
        'This filesystem observation grants no repository trust.',
        'filesystem',
        'partial',
      );
      const lockfiles = await Promise.all(
        [
          'package-lock.json',
          'pnpm-lock.yaml',
          'yarn.lock',
          'bun.lock',
          'uv.lock',
          'Cargo.lock',
          'Gemfile.lock',
        ].map(name =>
          statFile(join(scopeRoot, name), signal).catch(() => undefined),
        ),
      );
      const manifest = await metadata(
        join(scopeRoot, 'package.json'),
        signal,
      ).catch(() => undefined);
      const scripts = names(manifest?.value.scripts);
      const hint = [
        ...lockfiles.flatMap(item => (item ? [basename(item.path)] : [])),
        ...(scripts.length ? [`Scripts: ${scripts.join(', ')}`] : []),
      ];
      if (hint.length)
        observed(
          'recipe/metadata',
          'Recipes',
          'Local setup metadata',
          hint.join(' · ').slice(0, 300),
          'filesystem',
          'partial',
        );
    } else {
      observed(
        'repository/context',
        'Repositories and trust',
        'Repository context',
        'Choose a local checkout to inspect its metadata.',
      );
    }
    observed(
      'worktree/contract',
      'Worktrees and branches',
      'Worktree provider',
      'A custom provider needs an owner-supplied operation descriptor and local verification.',
    );
    if (!observations.some(item => item.group === 'Recipes'))
      observed(
        'recipe/context',
        'Recipes',
        'Setup and cleanup',
        'Review declared steps against the selected repository before use.',
      );
    observed(
      'github/tracked',
      'GitHub',
      'Tracked repositories',
      repositories
        ? `${repositories} saved on this computer. GitHub account status was not checked.`
        : 'No saved repositories. GitHub account status was not checked.',
      'projection',
      'observed',
    );
    observed(
      'limits/observations',
      'Limits',
      'Provider limit evidence',
      usage.available
        ? `${usage.count} cached utilization windows. More history is required to suggest a threshold.`
        : 'Usage thresholds need verified account and window observations.',
      usage.available ? 'cached' : 'unavailable',
      'partial',
    );
    observations.push({
      id: 'import/catalog',
      group: 'Sessions to import',
      label: 'Existing conversations',
      description:
        'Open the import picker to check supported CLI and manager sources.',
      source: 'Detected',
      evidence: 'unavailable',
      readiness: 'not-checked',
      classification: 'observation',
      action: 'import',
    });
    for (const declaration of candidate.declarations.slice(0, 65)) {
      const group = profileGroups[declaration.key.split('/')[0] ?? ''];
      if (!group) continue;
      const masked = declaration.state === 'masked';
      observations.push({
        id: 'profile/' + declaration.key,
        group,
        label: declaration.label,
        description: masked
          ? 'Disabled by profile.'
          : 'Declared in the profile. Runtime admission is withheld.',
        source: 'Profile',
        evidence: 'projection',
        readiness: 'withheld',
        classification: 'execution',
        identity: declaration.revision,
        action: masked ? undefined : 'review',
      });
    }
    if (this.lifetime.aborted)
      throw new ConfigurationRefusal(
        'unavailable',
        'The computer is shutting down.',
      );
    const findings = observations.map(({ identity, ...item }) => ({
      ...item,
      revision: digest([item, identity]),
      verifiedAt: time,
    }));
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'setup_review'")
      .get();
    const baseline: Baseline | undefined = row?.value
      ? JSON.parse(String(row.value))
      : undefined;
    const report = setupScanSchema.parse({
      instanceId: this.instanceId,
      revision: this.nextRevision(),
      scannedAt: time,
      directory: scopeRoot,
      completed: baseline?.completed ?? false,
      reviewedRevision: baseline?.revision ?? null,
      findings,
      changes: findings
        .filter(
          item => baseline && baseline.findings[item.id] !== item.revision,
        )
        .map(item => item.id),
    });
    this.cache.set(scope, report);
    if (this.cache.size > 12) {
      const extra = [...this.cache.keys()].find(key => key !== '');
      if (extra !== undefined) this.cache.delete(extra);
    }
    return report;
  }
}
