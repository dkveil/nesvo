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
  type SetupChoice,
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
import { setupRuntimeRequirement } from './setup-runtime-requirements';
import { SetupToolDiagnostics } from './setup-tool-diagnostics';

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
    return object(
      file.endsWith('.toml') ? parseToml(document) : JSON.parse(document),
    );
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
  diagnostics: SetupToolDiagnostics,
): Promise<Observation[]> {
  return (
    await Promise.all(
      (['claude', 'codex'] as const).map(async provider => {
        const label = provider === 'claude' ? 'Claude Code' : 'Codex';
        const root = staticConfigRoot(provider, directory);
        const userRoot =
          process.env.CLAUDE_CONFIG_DIR ||
          process.env.NESVO_TEST_MODE === '1' ||
          process.env.NESVO_ISOLATED_PROFILE === '1'
            ? root
            : homedir();
        const paths =
          provider === 'claude'
            ? [join(userRoot, '.claude.json'), join(root, 'settings.json')]
            : [join(root, 'config.toml')];
        const [executable, configs] = await Promise.all([
          binary(provider, signal),
          Promise.all(paths.map(path => metadata(path, signal))),
        ]);
        const verified = executable && diagnostics.result(provider, executable);
        const findings: Observation[] = [
          {
            id: 'provider/' + provider,
            group: 'Providers',
            label,
            description: verified?.version
              ? `CLI version ${verified.version} verified. Account and capabilities were not checked.`
              : verified
                ? 'Executable found. The approved version check could not verify its version.'
                : executable
                  ? 'Executable found. Version, account and capabilities have not been verified in this scan.'
                  : 'No executable was found in the inspected paths.',
            source: 'Detected',
            evidence: verified?.version
              ? 'cached'
              : executable
                ? 'filesystem'
                : 'unavailable',
            readiness: !executable
              ? 'unavailable'
              : verified && !verified.version
                ? 'partial'
                : 'observed',
            classification: 'observation',
            identity: executable ? digest(executable) : undefined,
          },
        ];
        for (const [index, config] of configs.entries()) {
          if (!config) continue;
          const serverConfig =
            config[provider === 'claude' ? 'mcpServers' : 'mcp_servers'];
          const hookConfig = config.hooks;
          const servers = names(serverConfig);
          const hooks = names(hookConfig);
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
            identity: digest([serverConfig, hookConfig]),
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
  branches: 'Worktrees and branches',
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
  private readonly diagnostics: SetupToolDiagnostics;

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
  ) {
    this.diagnostics = new SetupToolDiagnostics(directory, lifetime, binary);
  }

  async diagnosticRequest(
    input: Extract<
      SetupDetectionInput,
      {
        action: 'diagnostic-preview' | 'verify-diagnostics';
      }
    >,
  ) {
    if (input.instanceId !== this.instanceId)
      throw new ConfigurationRefusal(
        'conflict',
        'The computer changed. Review its tools again.',
      );
    if (input.action === 'diagnostic-preview')
      return {
        scan: this.cache.get('') ?? (await this.scan({ trigger: 'manual' })),
        diagnostics: await this.diagnostics.preview(),
      };
    await this.diagnostics.verify(input.digest);
    return { scan: await this.scan({ trigger: 'manual' }) };
  }

  scan(input: SetupScanRequest): Promise<SetupScan> {
    const scope =
      input.trigger !== 'startup' && input.directory
        ? resolve(input.directory)
        : '';
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
    const task = this.collect(input.trigger, scope).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, task);
    return task;
  }

  async acknowledge(
    input: Extract<SetupDetectionInput, { action: 'acknowledge' }>,
  ) {
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
    const latest = await this.collect('manual', '', report.revision);
    const revisions = new Map(
      latest.findings.map(item => [item.id, item.revision]),
    );
    if (
      this.cache.get('') !== report ||
      revisions.size !== report.findings.length ||
      report.findings.some(item => revisions.get(item.id) !== item.revision)
    )
      throw new ConfigurationRefusal(
        'conflict',
        'A setup finding changed. Refresh the scan before marking it reviewed.',
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

  async applyChoices(
    input: Extract<SetupDetectionInput, { action: 'apply-choices' }>,
  ) {
    const report = this.cache.get('');
    if (
      !report ||
      input.instanceId !== this.instanceId ||
      input.revision !== report.revision
    )
      throw new ConfigurationRefusal(
        'conflict',
        'Refresh Your setup before applying choices.',
      );
    const live = await this.collect('manual', '', report.revision);
    const selectable = new Map(
      live.findings
        .filter(item => item.action === 'review')
        .map(item => [item.id, item]),
    );
    const chosen = new Set(input.choices.map(item => item.id));
    if (
      this.cache.get('') !== report ||
      chosen.size !== input.choices.length ||
      input.choices.some(
        item => selectable.get(item.id)?.revision !== item.revision,
      )
    )
      throw new ConfigurationRefusal(
        'conflict',
        'A selected finding changed. Review the current choices.',
      );
    const remembered = new Map(
      this.choices(live.findings).map(item => [item.id, item]),
    );
    for (const choice of input.choices) remembered.set(choice.id, choice);
    const choices = [...remembered.values()];
    this.database
      .prepare(
        "INSERT INTO metadata (key, value) VALUES ('setup_choices', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(choices));
    const selected = { ...report, choices };
    this.cache.set('', selected);
    return selected;
  }

  private choices(findings: SetupFinding[]): SetupChoice[] {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'setup_choices'")
      .get();
    const known: SetupChoice[] =
      typeof row?.value === 'string' ? JSON.parse(row.value) : [];
    const live = new Map(
      findings
        .filter(item => item.action === 'review')
        .map(item => [item.id, item.revision]),
    );
    return known.filter(choice => live.get(choice.id) === choice.revision);
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

  private baseline(): Baseline | undefined {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'setup_review'")
      .get();
    return row?.value ? JSON.parse(String(row.value)) : undefined;
  }

  private async collect(
    trigger: SetupScanRequest['trigger'],
    scope: string,
    verifyRevision?: number,
  ) {
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(2800)]);
    const time = new Date().toISOString();
    const monitor = trigger === 'startup';
    if (monitor && !this.baseline())
      return setupScanSchema.parse({
        instanceId: this.instanceId,
        revision: 1,
        scannedAt: time,
        directory: null,
        completed: false,
        reviewedRevision: null,
        findings: [],
        changes: [],
      });
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
    const scopeRoot = await repoMetadata(scope, signal).catch(() => null);
    if (trigger !== 'first-open') {
      const scanned = await providers(
        this.directory,
        signal,
        this.diagnostics,
      ).catch(() => []);
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
      const scripts = names(manifest?.scripts);
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
      const ordinary = declaration.state === 'ordinary';
      observations.push({
        id: 'profile/' + declaration.key,
        group,
        label: declaration.label,
        description: ordinary
          ? (declaration.preview ?? 'Ordinary profile setting.')
          : masked
            ? 'Disabled by profile.'
            : (setupRuntimeRequirement(declaration.key)?.description ??
              'Declared in the profile. Runtime admission is withheld.'),
        source: 'Profile',
        evidence: 'projection',
        readiness: ordinary ? 'observed' : 'withheld',
        classification: ordinary ? 'ordinary' : 'execution',
        identity: declaration.revision,
        action: masked || ordinary ? undefined : 'review',
      });
    }
    if (this.lifetime.aborted)
      throw new ConfigurationRefusal(
        'unavailable',
        'The computer is shutting down.',
      );
    const baseline = this.baseline();
    if (
      baseline &&
      trigger !== 'first-open' &&
      !observations.some(item => item.id === 'provider/partial')
    ) {
      const observedIds = new Set(observations.map(item => item.id));
      for (const id of Object.keys(baseline.findings)) {
        if (
          !/^configuration\/(claude|codex)\/\d$/u.test(id) ||
          observedIds.has(id)
        )
          continue;
        const label = id.startsWith('configuration/claude/')
          ? 'Claude Code'
          : 'Codex';
        observations.push({
          id,
          group: 'Agent configuration',
          label: label + ' user configuration',
          description:
            'Previously observed hook or MCP metadata is no longer available.',
          source: 'Detected',
          evidence: 'unavailable',
          readiness: 'withheld',
          classification: 'execution',
        });
      }
    }
    const findings = observations.map(({ identity, ...item }) => ({
      ...item,
      revision: digest([item, identity]),
      verifiedAt: time,
    }));
    const report = setupScanSchema.parse({
      instanceId: this.instanceId,
      revision:
        verifyRevision ??
        (monitor ? (baseline?.revision ?? 1) : this.nextRevision()),
      scannedAt: time,
      directory: scopeRoot,
      completed: baseline?.completed ?? false,
      reviewedRevision: baseline?.revision ?? null,
      findings,
      ...(monitor || trigger === 'first-open'
        ? {}
        : { choices: this.choices(findings) }),
      changes: findings
        .filter(
          item => baseline && baseline.findings[item.id] !== item.revision,
        )
        .map(item => item.id),
    });
    if (monitor || verifyRevision !== undefined) return report;
    this.cache.set(scope, report);
    if (this.cache.size > 12) {
      const extra = [...this.cache.keys()].find(key => key !== '');
      if (extra !== undefined) this.cache.delete(extra);
    }
    return report;
  }
}
