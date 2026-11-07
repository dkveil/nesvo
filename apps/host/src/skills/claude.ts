import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import {
  skillLimits,
  type SkillDiscovery,
  type SkillEntry,
} from '@nesvo/contracts';

type Source = SkillEntry['source'];
type Root = { path: string; source: Source; projectRoot: string | null };
type Candidate = {
  entry: SkillEntry;
  canonical: string;
  key: string;
  root: Root;
};
type Metadata = {
  fields: Record<string, unknown> | null;
  body: string;
  detail: string | null;
};
type Visibility = 'on' | 'name-only' | 'user-invocable-only' | 'off';

const scanMilliseconds = 3_000;
const maxVisited = 4_000;
const maxHeaderBytes = 64 * 1024;
const maxFrontmatterBytes = 32 * 1024;
const maxSettingsBytes = 128 * 1024;
const maxAncestorDepth = 64;
const maxCommandDepth = 8;
const inventoryDetail =
  'Filesystem inventory only. CLI availability and effective permissions are unverified; plugins, synced and bundled skills, remote policies and runtime-loaded directories are not included. Invocation is unavailable.';
const declarationDetail =
  'Invocation flags describe file declarations, not effective CLI permissions.';

class DiscoveryLimit extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

function keyPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function declaredBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  return null;
}

function refusedName(name: string): boolean {
  return !name || /[\p{C}<>]|[^\S ]|  |^ | $/u.test(name);
}

function reservedName(name: string, kind: SkillEntry['kind']): boolean {
  const lower = name.toLowerCase();
  return (
    (kind === 'skill' && lower === 'synced') ||
    lower === 'anthropic-skills' ||
    lower.startsWith('anthropic-skills:')
  );
}

function parseMetadata(prefix: string): Metadata {
  if (!/^---(?:\r?\n|$)/.test(prefix))
    return { fields: {}, body: prefix, detail: null };
  const header = prefix.slice(prefix.indexOf('\n') + 1);
  const match = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(header);
  if (
    !match ||
    Buffer.byteLength(header.slice(0, match.index)) > maxFrontmatterBytes
  ) {
    return {
      fields: null,
      body: '',
      detail:
        'Frontmatter exceeds the supported header limit or has no closing delimiter.',
    };
  }
  const yaml = header.slice(0, match.index);
  const body = header.slice(match.index + match[0].length);
  if (/(?:^|[\s,[{])(?:[&*][\w-]+|!!?[^\s]+)/m.test(yaml)) {
    return {
      fields: null,
      body,
      detail:
        'YAML anchors, aliases and explicit tags are not evaluated by discovery.',
    };
  }
  try {
    let depth = 0;
    let nodes = 0;
    const fields = load(yaml, {
      schema: JSON_SCHEMA,
      listener: event => {
        if (event === 'open' && (++depth > 12 || ++nodes > 512))
          throw new Error('YAML budget exceeded.');
        if (event === 'close') depth--;
      },
    });
    if (fields !== undefined && fields !== null && !record(fields)) {
      return {
        fields: null,
        body,
        detail:
          'Frontmatter is not a metadata mapping; CLI defaults were not inferred.',
      };
    }
    return { fields: record(fields) ?? {}, body, detail: null };
  } catch {
    return {
      fields: null,
      body,
      detail:
        'Frontmatter could not be parsed within discovery limits; CLI defaults were not inferred.',
    };
  }
}

function managedDirectory(): string {
  if (process.platform === 'win32')
    return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode');
  return process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode'
    : '/etc/claude-code';
}

export async function inspectClaudeSkills(
  directory: string,
  signal?: AbortSignal,
  budget?: {
    deadline: number;
    onVisit: () => boolean;
    canonicalPaths?: boolean;
  },
): Promise<SkillDiscovery> {
  const result: SkillDiscovery = {
    provider: 'Claude Code',
    method: 'filesystem',
    status: 'partial',
    skills: [],
    issues: [],
    truncated: false,
    invocationSupported: false,
    checkedAt: new Date().toISOString(),
  };
  const deadline = Math.min(
    Date.now() + scanMilliseconds,
    budget?.deadline ?? Infinity,
  );
  let visited = 0;
  const candidates: Candidate[] = [];
  const inheritedIsolation =
    declaredBoolean(process.env.CLAUDE_CODE_SAFE_MODE) === true ||
    declaredBoolean(process.env.CLAUDE_CODE_SIMPLE) === true;
  const overrides = new Map<string, { value: Visibility; path: string }>();
  let lockedSkills = false;
  const issue = (path: string | null, message: string) => {
    if (result.issues.length < skillLimits.issues) {
      result.issues.push({
        path: path?.slice(0, skillLimits.path) ?? null,
        message: message.slice(0, skillLimits.detail),
      });
    } else result.truncated = true;
  };
  issue(null, inventoryDetail);
  const check = () => {
    if (signal?.aborted)
      throw new DiscoveryLimit('Skill discovery was cancelled.');
    if (Date.now() >= deadline)
      throw new DiscoveryLimit('Skill discovery reached its time limit.');
    if (visited >= maxVisited)
      throw new DiscoveryLimit(
        'Skill discovery reached its filesystem entry limit.',
      );
  };
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      check();
    } catch (error) {
      void promise.catch(() => {});
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DiscoveryLimit('Skill discovery reached its time limit.'),
              ),
            Math.max(1, deadline - Date.now()),
          );
          abort = () =>
            reject(new DiscoveryLimit('Skill discovery was cancelled.'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  };
  const resource = async <T>(
    promise: Promise<T>,
    close: (value: T) => Promise<void>,
  ): Promise<T> => {
    try {
      return await bounded(promise);
    } catch (error) {
      void promise.then(close, () => {}).catch(() => {});
      throw error;
    }
  };
  const prefix = async (
    path: string,
    limit: number,
    headerOnly = false,
  ): Promise<string> => {
    const file = await resource(
      open(path, constants.O_RDONLY | constants.O_NONBLOCK),
      file => file.close(),
    );
    try {
      if (!(await bounded(file.stat())).isFile())
        throw new Error('not-regular');
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes <= limit) {
        const buffer = Buffer.alloc(Math.min(4096, limit + 1 - bytes));
        const read = await bounded(file.read(buffer, 0, buffer.length, bytes));
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        chunks.push(buffer.subarray(0, read.bytesRead));
        if (headerOnly) {
          const text = Buffer.concat(chunks).toString('utf8');
          const frontmatter = /^---(?:\r?\n|$)/.test(text);
          const end = frontmatter
            ? /(?:^|\r?\n)---(?:\r?\n|$)/.exec(
                text.slice(text.indexOf('\n') + 1),
              )
            : null;
          if (
            (!frontmatter && text.includes('\n')) ||
            (end &&
              text
                .slice(text.indexOf('\n') + 1 + end.index + end[0].length)
                .split(/\r?\n/)
                .some(line => line.trim()))
          )
            break;
        }
        if (bytes > limit) throw new Error('too-large');
      }
      if (bytes > limit) throw new Error('too-large');
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      void file.close().catch(() => {});
    }
  };
  const directoryEntries = async (
    path: string,
    each: (name: string) => Promise<void>,
  ): Promise<void> => {
    let dir;
    try {
      dir = await resource(opendir(path), value => value.close());
    } catch (error) {
      if (error instanceof DiscoveryLimit) throw error;
      if (!missing(error)) issue(path, 'Directory could not be read.');
      return;
    }
    try {
      while (true) {
        check();
        const item = await bounded(dir.read());
        if (!item) break;
        visited++;
        if (budget && !budget.onVisit())
          throw new DiscoveryLimit(
            'Skill discovery reached its filesystem entry limit.',
          );
        await each(item.name);
      }
    } finally {
      void dir.close().catch(() => {});
    }
  };
  const settings = async (path: string, managed: boolean) => {
    try {
      const parsed = record(
        JSON.parse(await prefix(path, maxSettingsBytes)) as unknown,
      );
      if (!parsed) {
        issue(
          path,
          'Settings are not a JSON object; skill visibility could not be inspected.',
        );
        return;
      }
      const values = record(parsed.skillOverrides);
      if (values) {
        for (const [name, value] of Object.entries(values)) {
          if (
            typeof value === 'string' &&
            ['on', 'name-only', 'user-invocable-only', 'off'].includes(value)
          )
            overrides.set(name, { value: value as Visibility, path });
        }
      }
      if (managed && Object.hasOwn(parsed, 'strictPluginOnlyCustomization')) {
        const value = parsed.strictPluginOnlyCustomization;
        lockedSkills =
          value === true ||
          (Array.isArray(value) && (lockedSkills || value.includes('skills')));
      }
    } catch (error) {
      if (error instanceof DiscoveryLimit) throw error;
      if (!missing(error))
        issue(
          path,
          'Settings could not be inspected as bounded JSON; effective visibility remains unknown.',
        );
    }
  };
  const add = async (
    path: string,
    root: Root,
    kind: SkillEntry['kind'],
    command: string,
  ) => {
    check();
    if (candidates.length >= skillLimits.entries)
      throw new DiscoveryLimit('Skill discovery reached its result limit.');
    if (path.length > skillLimits.path) {
      issue(null, 'A skill path exceeds the supported length.');
      return;
    }
    try {
      const canonical = await bounded(realpath(path));
      const metadata = parseMetadata(await prefix(path, maxHeaderBytes, true));
      const declaredName =
        kind === 'skill' && typeof metadata.fields?.name === 'string'
          ? metadata.fields.name
          : null;
      const name =
        declaredName && !refusedName(declaredName) ? declaredName : command;
      const description =
        typeof metadata.fields?.description === 'string'
          ? metadata.fields.description
          : (metadata.body
              .split(/\r?\n/)
              .find(line => line.trim())
              ?.trim() ?? '');
      const userInvocable = declaredBoolean(
        metadata.fields?.['user-invocable'],
      );
      const disableModel = declaredBoolean(
        metadata.fields?.['disable-model-invocation'],
      );
      let detail = declarationDetail;
      let enabled: boolean | null = null;
      if (metadata.detail) {
        detail += ` ${metadata.detail}`;
        issue(path, metadata.detail);
      }
      if (reservedName(command, kind) || refusedName(command)) {
        enabled = false;
        detail +=
          ' This directory or command name is reserved or refused by Claude Code.';
      }
      if (declaredName && refusedName(declaredName))
        detail +=
          ' The declared name is refused by Claude Code; the directory name is shown.';
      if (lockedSkills && root.source !== 'managed') {
        enabled = false;
        detail += ' A local managed setting disables skills from this source.';
      }
      if (inheritedIsolation) {
        enabled = false;
        detail +=
          ' The inherited Claude isolation mode disables customization auto-discovery.';
      }
      const override = overrides.get(command) ?? overrides.get(name);
      if (override?.value === 'off') {
        enabled = false;
        detail += ' A discovered skillOverrides setting disables this name.';
      }
      if (override) detail += ` Observed visibility: ${override.value}.`;
      candidates.push({
        canonical: keyPath(canonical),
        key: command,
        root,
        entry: {
          id: createHash('sha256')
            .update(
              `claude\0${keyPath(canonical)}\0${root.source}\0${kind}\0${name}`,
            )
            .digest('hex'),
          name: name.slice(0, skillLimits.name),
          description: description.slice(0, skillLimits.description),
          path: budget?.canonicalPaths ? canonical : path,
          source: root.source,
          kind,
          enabled,
          userInvocable,
          modelInvocable: disableModel === null ? null : !disableModel,
          detail: detail.slice(0, skillLimits.detail),
        },
      });
    } catch (error) {
      if (error instanceof DiscoveryLimit) throw error;
      if (!missing(error))
        issue(
          path,
          'Skill metadata could not be read within the supported file limits.',
        );
    }
  };
  const scan = async (root: Root) => {
    await directoryEntries(join(root.path, 'skills'), async name => {
      const path = join(root.path, 'skills', name, 'SKILL.md');
      const manifest = join(
        root.path,
        'skills',
        name,
        '.claude-plugin',
        'plugin.json',
      );
      try {
        await bounded(lstat(manifest));
        issue(
          manifest,
          'Skills-directory plugin catalog is not included in filesystem skill discovery.',
        );
        return;
      } catch (error) {
        if (error instanceof DiscoveryLimit) throw error;
        if (!missing(error)) {
          issue(
            manifest,
            'A possible skills-directory plugin could not be inspected.',
          );
          return;
        }
      }
      await add(path, root, 'skill', name);
    });
    const seen = new Set<string>();
    const commands = async (
      path: string,
      parts: string[],
      depth: number,
    ): Promise<void> => {
      if (depth > maxCommandDepth) {
        result.truncated = true;
        issue(path, 'Command discovery reached its directory depth limit.');
        return;
      }
      let canonical: string;
      try {
        canonical = keyPath(await bounded(realpath(path)));
        if (seen.has(canonical)) return;
        seen.add(canonical);
      } catch (error) {
        if (error instanceof DiscoveryLimit) throw error;
        if (!missing(error))
          issue(path, 'Command directory could not be resolved.');
        return;
      }
      await directoryEntries(path, async name => {
        const child = join(path, name);
        try {
          const info = await bounded(stat(child));
          if (info.isDirectory())
            await commands(child, [...parts, name], depth + 1);
          else if (info.isFile() && name.endsWith('.md'))
            await add(
              child,
              root,
              'command',
              [...parts, name.slice(0, -3)].join(':'),
            );
        } catch (error) {
          if (error instanceof DiscoveryLimit) throw error;
          if (!missing(error))
            issue(child, 'Command entry could not be inspected.');
        }
      });
    };
    await commands(join(root.path, 'commands'), [], 0);
  };
  try {
    if (!isAbsolute(directory)) throw new Error('directory');
    const cwd = await bounded(realpath(directory));
    if (!(await bounded(stat(cwd))).isDirectory()) throw new Error('directory');
    const ancestors: string[] = [];
    let cursor = cwd;
    let projectRoot = cwd;
    for (let depth = 0; depth < maxAncestorDepth; depth++) {
      check();
      ancestors.push(cursor);
      projectRoot = cursor;
      try {
        await bounded(lstat(join(cursor, '.git')));
        break;
      } catch (error) {
        if (error instanceof DiscoveryLimit) throw error;
        if (!missing(error)) {
          issue(
            join(cursor, '.git'),
            'Repository boundary could not be inspected.',
          );
          break;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      if (depth === maxAncestorDepth - 1) {
        result.truncated = true;
        issue(cursor, 'Project ancestor discovery reached its depth limit.');
      }
      cursor = parent;
    }
    const config = process.env.CLAUDE_CONFIG_DIR
      ? resolve(directory, process.env.CLAUDE_CONFIG_DIR)
      : join(homedir(), '.claude');
    const managed = managedDirectory();
    await settings(join(config, 'settings.json'), false);
    await settings(join(cwd, '.claude', 'settings.json'), false);
    await settings(join(cwd, '.claude', 'settings.local.json'), false);
    await settings(join(managed, 'managed-settings.json'), true);
    const fragments: string[] = [];
    await directoryEntries(join(managed, 'managed-settings.d'), async name => {
      if (name.endsWith('.json')) fragments.push(name);
    });
    for (const name of fragments.sort())
      await settings(join(managed, 'managed-settings.d', name), true);
    const roots: Root[] = [
      { path: join(managed, '.claude'), source: 'managed', projectRoot: null },
      { path: config, source: 'user', projectRoot: null },
      ...ancestors.reverse().map(path => ({
        path: join(path, '.claude'),
        source: 'project' as const,
        projectRoot,
      })),
    ];
    const scanned = new Set<string>();
    for (const root of roots) {
      const key = keyPath(root.path);
      if (!scanned.has(key)) {
        scanned.add(key);
        await scan(root);
      }
    }
    issue(
      null,
      'Git worktree fallback to main-checkout skills and non-file managed policy sources are not inspected.',
    );
  } catch (error) {
    if (error instanceof DiscoveryLimit) {
      result.truncated = true;
      issue(null, error.message);
    } else {
      result.status = 'unavailable';
      issue(null, 'The session directory could not be inspected.');
    }
  }
  const ranked = candidates.sort((left, right) => {
    const rank = (item: Candidate) =>
      (item.entry.kind === 'skill' ? 10 : 0) +
      ({ managed: 3, user: 2, project: 1 }[
        item.entry.source as 'managed' | 'user' | 'project'
      ] ?? 0);
    return (
      rank(right) - rank(left) ||
      Number(keyPath(right.entry.path!) === right.canonical) -
        Number(keyPath(left.entry.path!) === left.canonical) ||
      left.entry.path!.localeCompare(right.entry.path!)
    );
  });
  const aliases = new Map<string, Set<string>>();
  for (const candidate of ranked) {
    const keys = aliases.get(candidate.canonical) ?? new Set<string>();
    keys.add(candidate.key);
    aliases.set(candidate.canonical, keys);
  }
  const canonicalSeen = new Set<string>();
  const disabledAliases = new Map(
    budget?.canonicalPaths
      ? ranked
          .filter(item => item.entry.enabled === false)
          .map(item => [item.canonical, item.entry.detail] as const)
      : [],
  );
  const names = new Map<string, Candidate>();
  for (const candidate of ranked) {
    if (canonicalSeen.has(candidate.canonical)) continue;
    canonicalSeen.add(candidate.canonical);
    if (disabledAliases.has(candidate.canonical)) {
      candidate.entry.enabled = false;
      candidate.entry.detail =
        disabledAliases.get(candidate.canonical) ?? candidate.entry.detail;
    }
    const keys = [...aliases.get(candidate.canonical)!];
    const winner = keys
      .map(key => names.get(key))
      .find(value => value && value.canonical !== candidate.canonical);
    if (winner && winner.entry.enabled !== false) {
      if (
        candidate.entry.source === winner.entry.source &&
        candidate.entry.kind === winner.entry.kind
      ) {
        candidate.entry.detail =
          `${candidate.entry.detail} A same-name definition exists in this source; runtime name resolution is unverified.`.slice(
            0,
            skillLimits.detail,
          );
      } else {
        candidate.entry.enabled = false;
        candidate.entry.detail =
          `${candidate.entry.detail} This name is shadowed by a higher-precedence discovered ${winner.entry.source} ${winner.entry.kind}.`.slice(
            0,
            skillLimits.detail,
          );
      }
    } else for (const key of keys) names.set(key, candidate);
    result.skills.push(candidate.entry);
  }
  result.skills.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      (left.path ?? '').localeCompare(right.path ?? ''),
  );
  return result;
}
