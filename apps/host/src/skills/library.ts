import { createHash } from 'node:crypto';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  skillLimits,
  type SkillDiscovery,
  type SkillEntry,
} from '@nesvo/contracts';
import { inspectClaudeSkills } from './claude';
import { readSkillSnapshot, type SkillSnapshot } from './portable';

type Origin = 'Claude Code' | 'Codex' | 'Shared';
type Root = {
  path: string;
  source: SkillEntry['source'];
  origin: Origin;
  depth: number;
};
type Library = Pick<SkillDiscovery, 'skills' | 'issues' | 'truncated'>;
const milliseconds = 3000;
const maxVisited = 4000;
const maxDepth = 8;
const originOrder: Origin[] = ['Claude Code', 'Codex', 'Shared'];

class LibraryLimit extends Error {}

function keyPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

function declaredBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return null;
}

function metadata(
  snapshot: SkillSnapshot,
): Pick<
  SkillEntry,
  'name' | 'description' | 'userInvocable' | 'modelInvocable'
> {
  const { fields, body } = snapshot;
  if (
    (fields.name !== undefined &&
      (typeof fields.name !== 'string' ||
        !fields.name.trim() ||
        fields.name.length > skillLimits.name)) ||
    (fields.description !== undefined && typeof fields.description !== 'string')
  )
    throw new Error('Invalid skill name or description.');
  const disableModel = declaredBoolean(fields['disable-model-invocation']);
  return {
    name: (typeof fields.name === 'string'
      ? fields.name
      : basename(dirname(snapshot.path))
    ).slice(0, skillLimits.name),
    description: (typeof fields.description === 'string'
      ? fields.description
      : (body
          .split(/\r?\n/)
          .find(line => line.trim())
          ?.trim() ?? '')
    ).slice(0, skillLimits.description),
    userInvocable: declaredBoolean(fields['user-invocable']),
    modelInvocable: disableModel === null ? null : !disableModel,
  };
}

export async function inspectLocalSkillLibrary(
  directory: string,
  signal: AbortSignal,
): Promise<Library> {
  const result: Library = { skills: [], issues: [], truncated: false };
  const entries = new Map<string, SkillEntry>();
  const priorities = new Map<string, number>();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const deadline = Date.now() + milliseconds;
  const timer = setTimeout(cancel, milliseconds);
  let visited = 0;
  const consume = () => ++visited <= maxVisited;
  const issue = (path: string | null, message: string) => {
    if (result.issues.length >= skillLimits.issues) {
      result.truncated = true;
      return;
    }
    const item = {
      path: path?.slice(0, skillLimits.path) ?? null,
      message: message.slice(0, skillLimits.detail),
    };
    if (
      !result.issues.some(
        existing =>
          existing.path === item.path && existing.message === item.message,
      )
    )
      result.issues.push(item);
  };
  issue(
    null,
    'Local filesystem library covers known Claude, Codex and shared skill roots, excluding .git and node_modules subtrees. Provider plugins, bundled/admin skills, remote policies and runtime/custom roots are not globally enumerated; native provider reports may add coverage. File declarations do not establish effective provider permissions.',
  );
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline)
      throw new LibraryLimit(
        signal.aborted
          ? 'Local skill discovery was cancelled.'
          : 'Local skill discovery reached its time limit.',
      );
    if (visited > maxVisited)
      throw new LibraryLimit(
        'Local skill discovery reached its filesystem entry limit.',
      );
  };
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let abort: (() => void) | undefined;
    try {
      check();
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(
              new LibraryLimit(
                signal.aborted
                  ? 'Local skill discovery was cancelled.'
                  : 'Local skill discovery reached its time limit.',
              ),
            );
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        }),
      ]);
    } catch (error) {
      void promise.catch(() => {});
      throw error;
    } finally {
      if (abort) controller.signal.removeEventListener('abort', abort);
    }
  };
  const merge = (entry: SkillEntry) => {
    if (!entry.path) return;
    const key = keyPath(entry.path);
    const existing = entries.get(key);
    const id = `library:${createHash('sha256').update(key).digest('hex')}`;
    const priority = entry.origins?.includes('Claude Code')
      ? 0
      : entry.origins?.includes('Codex')
        ? 1
        : 2;
    if (!existing) {
      entries.set(key, { ...entry, id });
      priorities.set(key, priority);
      return;
    }
    const origins = originOrder.filter(
      origin =>
        existing.origins?.includes(origin) || entry.origins?.includes(origin),
    );
    const disabled = existing.enabled === false || entry.enabled === false;
    const reason =
      existing.enabled === false
        ? existing.detail
        : entry.enabled === false
          ? entry.detail
          : null;
    if (priority < priorities.get(key)!) {
      Object.assign(existing, entry, { id });
      priorities.set(key, priority);
    }
    existing.origins = origins;
    existing.contentHash ??= entry.contentHash;
    if (disabled) {
      existing.enabled = false;
      if (reason && !existing.detail?.includes(reason))
        existing.detail = `${existing.detail ?? ''} ${reason}`
          .trim()
          .slice(0, skillLimits.detail);
    }
  };
  const addFile = async (path: string, root: Root, previous?: SkillEntry) => {
    check();
    let canonical: string;
    try {
      canonical = await bounded(realpath(path));
    } catch (error) {
      if (error instanceof LibraryLimit) throw error;
      if (!missing(error)) issue(path, 'A skill file could not be resolved.');
      return;
    }
    if (canonical.length > skillLimits.path) {
      result.truncated = true;
      issue(null, 'A skill file exceeds the supported path length.');
      return;
    }
    const entry: SkillEntry = previous
      ? { ...previous, path: canonical, origins: ['Claude Code'] }
      : {
          id: '',
          path: canonical,
          name:
            basename(dirname(canonical)).slice(0, skillLimits.name) ||
            'Unnamed skill',
          description: '',
          source: root.source,
          kind: 'skill',
          enabled: null,
          userInvocable: null,
          modelInvocable: null,
          origins: [root.origin],
          detail:
            'Local instruction file. Native availability and effective provider permissions are unverified.',
        };
    if (entry.kind === 'command') {
      merge(entry);
      return;
    }
    try {
      const snapshot = await bounded(
        readSkillSnapshot(canonical, controller.signal),
      );
      const parsed = metadata(snapshot);
      if (!previous) Object.assign(entry, parsed);
      entry.contentHash = snapshot.contentHash;
      if (declaredBoolean(snapshot.fields.enabled) === false) {
        entry.enabled = false;
        entry.detail =
          `${entry.detail ?? ''} The file declares enabled: false.`.slice(
            0,
            skillLimits.detail,
          );
      }
    } catch (error) {
      entry.enabled = false;
      entry.detail =
        `${entry.detail ?? ''} ${error instanceof LibraryLimit ? 'The instruction file was not validated within the discovery budget.' : 'The instruction file is unreadable, malformed or outside the supported UTF-8 document limits.'}`.slice(
          0,
          skillLimits.detail,
        );
      issue(canonical, entry.detail);
      merge(entry);
      if (error instanceof LibraryLimit) throw error;
      return;
    }
    merge(entry);
  };
  const claude = async () => {
    const inventory = await inspectClaudeSkills(directory, controller.signal, {
      deadline,
      onVisit: consume,
      canonicalPaths: true,
    });
    result.truncated ||= inventory.truncated;
    for (const item of inventory.issues)
      issue(
        item.path,
        `Claude inventory: ${item.message.replace(
          'Invocation is unavailable.',
          'Native invocation is unverified; portable use is validated separately.',
        )}`,
      );
    for (const entry of inventory.skills) {
      if (!entry.path) continue;
      try {
        await addFile(
          entry.path,
          {
            path: dirname(entry.path),
            source: entry.source,
            origin: 'Claude Code',
            depth: 0,
          },
          entry,
        );
      } catch (error) {
        if (!(error instanceof LibraryLimit)) throw error;
        result.truncated = true;
        issue(null, error.message);
        merge({
          ...entry,
          enabled: false,
          origins: ['Claude Code'],
          detail:
            'The instruction file was not validated within the discovery budget.',
        });
      }
    }
  };
  const local = async () => {
    if (!isAbsolute(directory)) throw new Error('directory');
    const cwd = await bounded(realpath(directory));
    if (!(await bounded(stat(cwd))).isDirectory()) throw new Error('directory');
    const testHome = process.env.NESVO_TEST_SKILLS_HOME;
    const home =
      testHome && isAbsolute(testHome) ? resolve(testHome) : homedir();
    if (testHome && !isAbsolute(testHome))
      issue(
        null,
        'NESVO_TEST_SKILLS_HOME was ignored because it is not an absolute path.',
      );
    const roots: Root[] = [
      {
        path: join(home, '.agents', 'skills'),
        source: 'user',
        origin: 'Shared',
        depth: 0,
      },
      {
        path: join(
          process.env.CODEX_HOME
            ? resolve(directory, process.env.CODEX_HOME)
            : join(home, '.codex'),
          'skills',
        ),
        source: 'user',
        origin: 'Codex',
        depth: 0,
      },
    ];
    if (process.platform !== 'win32')
      roots.unshift({
        path: '/etc/codex/skills',
        source: 'managed',
        origin: 'Codex',
        depth: 0,
      });
    let cursor = cwd;
    for (let depth = 0; depth < 64; depth++) {
      check();
      roots.push(
        {
          path: join(cursor, '.agents', 'skills'),
          source: 'project',
          origin: 'Shared',
          depth: 0,
        },
        {
          path: join(cursor, '.codex', 'skills'),
          source: 'project',
          origin: 'Codex',
          depth: 0,
        },
      );
      try {
        await bounded(lstat(join(cursor, '.git')));
        break;
      } catch (error) {
        if (error instanceof LibraryLimit) throw error;
        if (!missing(error)) {
          issue(
            join(cursor, '.git'),
            'The repository boundary could not be inspected.',
          );
          break;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      if (depth === 63) {
        result.truncated = true;
        issue(cursor, 'Project ancestor discovery reached its depth limit.');
      }
      cursor = parent;
    }
    const seen = new Set<string>();
    for (let index = 0; index < roots.length; index++) {
      check();
      const root = roots[index]!;
      if (root.depth > maxDepth) {
        result.truncated = true;
        issue(
          root.path,
          'Local skill discovery reached its directory depth limit.',
        );
        continue;
      }
      let canonical: string;
      try {
        canonical = await bounded(realpath(root.path));
        if (!(await bounded(stat(canonical))).isDirectory()) continue;
      } catch (error) {
        if (error instanceof LibraryLimit) throw error;
        if (!missing(error))
          issue(root.path, 'A local skill directory could not be resolved.');
        continue;
      }
      const key = `${keyPath(canonical)}\0${root.origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const opening = opendir(canonical, { bufferSize: 32 });
      let handle;
      try {
        handle = await bounded(opening);
      } catch (error) {
        void opening
          .then(
            value => value.close(),
            () => {},
          )
          .catch(() => {});
        if (error instanceof LibraryLimit) throw error;
        issue(canonical, 'A local skill directory could not be read.');
        continue;
      }
      try {
        while (true) {
          check();
          const child = await bounded(handle.read());
          if (!child) break;
          if (!consume())
            throw new LibraryLimit(
              'Local skill discovery reached its filesystem entry limit.',
            );
          if (child.name === '.git' || child.name === 'node_modules') continue;
          const path = join(canonical, child.name);
          if (child.name === 'SKILL.md') await addFile(path, root);
          else if (child.isDirectory() || child.isSymbolicLink()) {
            roots.push({ ...root, path, depth: root.depth + 1 });
          }
        }
      } finally {
        void handle.close().catch(() => {});
      }
    }
  };
  try {
    await Promise.all(
      [claude(), local()].map(task =>
        task.catch(error => {
          result.truncated = true;
          issue(
            null,
            error instanceof LibraryLimit
              ? error.message
              : 'A local skill source could not be inspected.',
          );
        }),
      ),
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
  }
  const sorted = [...entries.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.path ?? '').localeCompare(b.path ?? ''),
  );
  if (sorted.length > skillLimits.entries) {
    result.truncated = true;
    issue(null, 'The local skill library reached its result limit.');
  }
  result.skills = sorted.slice(0, skillLimits.entries);
  result.issues.sort(
    (left, right) =>
      (left.path ?? '').localeCompare(right.path ?? '') ||
      left.message.localeCompare(right.message),
  );
  return result;
}
