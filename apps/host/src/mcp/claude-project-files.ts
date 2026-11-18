import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ConfigTable } from './scoped-config';

export type ProjectFileDefinition = {
  id: string;
  name: string;
  detail: string;
  config: unknown;
};

const instructionFiles = [
  { path: 'CLAUDE.md', detail: 'Project instructions' },
  { path: join('.claude', 'CLAUDE.md'), detail: 'Project instructions' },
  { path: 'CLAUDE.local.md', detail: 'Local instructions' },
];
const maxCommands = 200;
const maxCommandBytes = 256 * 1024;
const maxCommandDepth = 4;
const commandListChars = 300;

const missing = (error: unknown) =>
  ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));

const insideRepository = async (path: string, repositoryRoot: string) => {
  const location = relative(repositoryRoot, await realpath(path));
  return !(
    location === '..' ||
    location.startsWith('..' + sep) ||
    isAbsolute(location)
  );
};

const instructionDefinitions = async (
  folder: string,
  repositoryRoot: string,
): Promise<ProjectFileDefinition[]> => {
  const found: ProjectFileDefinition[] = [];
  for (const file of instructionFiles) {
    const path = join(folder, file.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || !(await insideRepository(path, repositoryRoot)))
      continue;
    const name = file.path.replaceAll('\\', '/');
    found.push({
      id: `instructions:${name}`,
      name,
      detail: file.detail,
      config: name,
    });
  }
  return found;
};

const commandHashes = async (
  root: string,
  repositoryRoot: string,
  issues: string[],
  signal?: AbortSignal,
): Promise<ConfigTable> => {
  const hashes: ConfigTable = {};
  const visit = async (directory: string, parts: string[], depth: number) => {
    if (depth > maxCommandDepth) {
      issues.push('The repository commands are nested too deeply to review.');
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      signal?.throwIfAborted();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, [...parts, entry.name], depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (Object.keys(hashes).length >= maxCommands) {
        issues.push('The repository has too many commands to review.');
        return;
      }
      if (!(await insideRepository(path, repositoryRoot))) {
        issues.push('A repository command resolves outside the repository.');
        continue;
      }
      const info = await stat(path);
      if (info.size > maxCommandBytes) {
        issues.push('A repository command is too large to review.');
        continue;
      }
      hashes[[...parts, entry.name.slice(0, -3)].join(':')] = createHash(
        'sha256',
      )
        .update(await readFile(path, { signal }))
        .digest('hex');
    }
  };
  try {
    if (await insideRepository(root, repositoryRoot)) await visit(root, [], 0);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!missing(error))
      issues.push('The repository commands could not be read.');
  }
  return hashes;
};

export const settingsRest = (settings: ConfigTable): ConfigTable =>
  Object.fromEntries(
    Object.entries(settings).filter(
      ([key]) => key !== 'hooks' && key !== 'disableAllHooks',
    ),
  );

export const readClaudeProjectFiles = async (
  folder: string,
  repositoryRoot: string,
  settings: { project: ConfigTable; local: ConfigTable },
  issues: string[],
  signal?: AbortSignal,
) => {
  const commandsPath = join(folder, '.claude', 'commands');
  const [instructions, commands] = await Promise.all([
    instructionDefinitions(folder, repositoryRoot),
    commandHashes(commandsPath, repositoryRoot, issues, signal),
  ]);
  const definitions: ProjectFileDefinition[] = [...instructions];
  const commandNames = Object.keys(commands);
  if (commandNames.length)
    definitions.push({
      id: 'commands',
      name: '.claude/commands',
      detail:
        `Project commands: ${commandNames.map(name => `/${name}`).join(', ')}`.slice(
          0,
          commandListChars,
        ),
      config: commands,
    });
  for (const [scope, table] of [
    ['project', settings.project],
    ['local', settings.local],
  ] as const) {
    const rest = settingsRest(table);
    const keys = Object.keys(rest).sort();
    if (keys.length)
      definitions.push({
        id: `settings:${scope}`,
        name:
          scope === 'project'
            ? '.claude/settings.json'
            : '.claude/settings.local.json',
        detail:
          `${scope === 'project' ? 'Project' : 'Local'} settings: ${keys.join(', ')}`.slice(
            0,
            commandListChars,
          ),
        config: rest,
      });
  }
  return {
    definitions,
    commandsSource: commandNames.length
      ? { path: commandsPath, sections: { commands } }
      : null,
  };
};
