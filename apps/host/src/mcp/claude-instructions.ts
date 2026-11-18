import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { ProjectFileDefinition } from './claude-project-files';

const maxFileBytes = 256 * 1024;
const maxInstructionBytes = 4 * 1024 * 1024;
const maxIgnoreBytes = 2 * 1024 * 1024;
const maxFiles = 180;
const maxEntries = 16_384;
const maxDirectoryDepth = 32;
const maxImports = 512;
const maxImportDepth = 5;
const skipped = new Set(['.git', 'node_modules', 'vendor']);
const instructionName = /^claude(?:\.local)?\.md$/i;
const instructionLabel = (name: string) =>
  name.toLowerCase() === 'claude.local.md'
    ? 'Local instructions'
    : 'Project instructions';

type IgnoreLayer = { directory: string; patterns: Ignore };

const portable = (path: string) => path.split(sep).join('/');
const pathKey = (path: string) =>
  process.platform === 'win32' ? path.toLowerCase() : path;

const entryInfo = (path: string) =>
  lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

async function inspectPath(path: string) {
  const info = await entryInfo(path);
  if (
    info &&
    (info.isSymbolicLink() || pathKey(await realpath(path)) !== pathKey(path))
  )
    throw new Error('Symbolic links are refused.');
  return info;
}

async function readBounded(path: string, remaining: number) {
  const info = await inspectPath(path);
  if (!info?.isFile()) throw new Error('The path is not a readable file.');
  if (info.size > maxFileBytes) throw new Error('The file exceeds 256 KiB.');
  if (info.size > remaining)
    throw new Error('The total size limit was exceeded.');
  const flags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev)
      throw new Error('The file changed while it was being opened.');
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size)
      throw new Error('The file size changed while it was being read.');
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

function importPath(source: string, token: string, root: string) {
  const target = token.replace(/\\([ \t])/g, '$1');
  if (
    target.startsWith('~') ||
    (!isAbsolute(target) && /^(?:[a-z]:|[\\/])/i.test(target)) ||
    target.replace(/^[a-z]:/i, '').includes(':') ||
    /^[/\\]{2}/.test(target) ||
    /\p{Cc}/u.test(target)
  )
    return null;
  const absolute = resolve(dirname(source), target);
  const location = relative(root, absolute);
  return location === '..' ||
    location.startsWith('..' + sep) ||
    isAbsolute(location)
    ? null
    : absolute;
}

export async function readClaudeInstructions(
  root: string,
  sessionFolders: string[],
  issues: string[],
  signal?: AbortSignal,
): Promise<ProjectFileDefinition[]> {
  const files = new Map<
    string,
    { path: string; label: string; depth: number }
  >();
  const definitions: ProjectFileDefinition[] = [];
  const rules = new Set<string>();
  let instructionBytes = 0;
  let ignoreBytes = 0;
  let entries = 0;
  let imports = 0;
  const nameOf = (path: string) => portable(relative(root, path)) || '.';
  const issue = (path: string, detail: string) =>
    issues.push(`${detail} Affected path is ${nameOf(path)}.`);
  const report = (path: string, error: unknown) => {
    signal?.throwIfAborted();
    issue(
      path,
      error instanceof Error && !('code' in error)
        ? error.message
        : 'The path could not be read.',
    );
  };
  const add = (path: string, label: string, depth = 0) => {
    const key = pathKey(path);
    if (files.has(key)) return;
    if (files.size >= maxFiles)
      throw new Error(
        `The instruction file limit of ${maxFiles} was exceeded.`,
      );
    files.set(key, { path, label, depth });
  };
  const checkEntry = () => {
    signal?.throwIfAborted();
    if (++entries > maxEntries)
      throw new Error(
        `The scan limit of ${maxEntries} directory entries was exceeded.`,
      );
  };
  const addKnownInstructions = async (directory: string) => {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
      const path = join(directory, name);
      if (await entryInfo(path)) add(path, instructionLabel(name));
    }
  };
  const visitConfig = async (directory: string) => {
    if (!(await inspectPath(directory))?.isDirectory()) return;
    await addKnownInstructions(directory);
    const rulesPath = join(directory, 'rules');
    if (await entryInfo(rulesPath)) await visitRules(rulesPath);
  };
  const visit = async (
    directory: string,
    depth: number,
    inherited: IgnoreLayer[],
    isRules: boolean,
  ) => {
    if (depth > maxDirectoryDepth)
      throw new Error(
        `The scan depth limit of ${maxDirectoryDepth} was exceeded.`,
      );
    const info = await inspectPath(directory);
    if (!info?.isDirectory()) {
      issue(directory, 'The directory could not be read.');
      return;
    }
    let layers = inherited;
    const ignorePath = join(directory, '.gitignore');
    if (!isRules && (await inspectPath(ignorePath))) {
      const content = await readBounded(
        ignorePath,
        maxIgnoreBytes - ignoreBytes,
      );
      ignoreBytes += content.length;
      layers = [
        ...inherited,
        {
          directory,
          patterns: ignore({ ignorecase: process.platform === 'win32' }).add(
            content.toString('utf8'),
          ),
        },
      ];
    }
    for await (const entry of await opendir(directory)) {
      checkEntry();
      const path = join(directory, entry.name);
      const name = entry.name.toLowerCase();
      if (isRules && !entry.isDirectory()) {
        add(path, 'Project rule');
      } else if (!isRules && instructionName.test(name)) {
        add(path, instructionLabel(name));
      } else if (!isRules && skipped.has(name)) {
        continue;
      } else if (entry.isSymbolicLink()) {
        issue(path, 'Symbolic links are refused during instruction discovery.');
      } else if (entry.isDirectory()) {
        if (!isRules && name === '.claude') await visitConfig(path);
        if (!isRules && rules.has(pathKey(path))) continue;
        if (!isRules) {
          const decision = layers
            .map(layer =>
              layer.patterns.test(
                portable(relative(layer.directory, path)) + '/',
              ),
            )
            .findLast(result => result.ignored || result.unignored);
          if (decision?.ignored) continue;
        }
        await visit(path, depth + 1, layers, isRules);
      }
    }
  };
  const visitRules = async (directory: string) => {
    const key = pathKey(directory);
    if (rules.has(key)) return;
    rules.add(key);
    await visit(directory, 0, [], true);
  };

  try {
    for (const folder of sessionFolders) {
      await addKnownInstructions(folder);
      await visitConfig(join(folder, '.claude'));
    }
    await visit(root, 0, [], false);
  } catch (error) {
    report(root, error);
  }

  for (const { path, label, depth } of files.values()) {
    signal?.throwIfAborted();
    try {
      const content = await readBounded(
        path,
        maxInstructionBytes - instructionBytes,
      );
      instructionBytes += content.length;
      const name = nameOf(path);
      definitions.push({
        id: `instructions:${name}`,
        name,
        detail: `${label} · ${content.length} bytes`,
        config: createHash('sha256').update(content).digest('hex'),
      });
      for (const [, token] of content
        .toString('utf8')
        .matchAll(/(?<![\p{L}\p{N}_@])@((?:\\[ \t]|[^\s`"'<>])+)/gu)) {
        if (!token) continue;
        if (++imports > maxImports) {
          issue(
            path,
            `The instruction import limit of ${maxImports} was exceeded.`,
          );
          return definitions;
        }
        const target = importPath(path, token, root);
        if (!target) {
          issue(
            path,
            'An instruction import points outside the repository or uses an unsupported path.',
          );
        } else if (!files.has(pathKey(target))) {
          if (depth >= maxImportDepth)
            issue(
              path,
              `The instruction import depth limit of ${maxImportDepth} was exceeded.`,
            );
          else add(target, 'Imported instructions', depth + 1);
        }
      }
    } catch (error) {
      report(path, error);
    }
  }
  return definitions;
}
