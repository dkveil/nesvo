import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { McpRepositoryDefinition } from '@nesvo/contracts';
import type { ConfigTable } from './scoped-config';

export type ProjectFileDefinition = {
  id: string;
  name: string;
  detail: string;
  config: unknown;
  launches?: McpRepositoryDefinition['launches'];
};

type ReviewedFolder = {
  id: string;
  path: string;
  label: string;
  includes: (name: string) => boolean;
  entryName: (parts: string[], name: string) => string;
};

const markdownName = (parts: string[], name: string) =>
  [...parts, name.slice(0, -3)].join(':');
const reviewedFolders: ReviewedFolder[] = [
  {
    id: 'commands',
    path: join('.claude', 'commands'),
    label: 'Project commands',
    includes: name => name.endsWith('.md'),
    entryName: (parts, name) => `/${markdownName(parts, name)}`,
  },
  {
    id: 'agents',
    path: join('.claude', 'agents'),
    label: 'Project subagents',
    includes: name => name.endsWith('.md'),
    entryName: markdownName,
  },
  {
    id: 'skills',
    path: join('.claude', 'skills'),
    label: 'Project skills',
    includes: () => true,
    entryName: (parts, name) => [...parts, name].join('/'),
  },
  {
    id: 'output-styles',
    path: join('.claude', 'output-styles'),
    label: 'Project output styles',
    includes: name => name.endsWith('.md'),
    entryName: markdownName,
  },
];
const maxFiles = 200;
const maxFileBytes = 256 * 1024;
const maxDepth = 4;
const detailChars = 300;
const rawReviewLaunch = [{ requiresRawReview: true as const, fields: [] }];

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

const folderHashes = async (
  folder: ReviewedFolder,
  root: string,
  repositoryRoot: string,
  issues: string[],
  signal?: AbortSignal,
): Promise<ConfigTable> => {
  const hashes: ConfigTable = {};
  const label = folder.label.toLowerCase();
  const visit = async (directory: string, parts: string[], depth: number) => {
    if (depth > maxDepth) {
      issues.push(`The repository ${label} are nested too deeply to review.`);
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      signal?.throwIfAborted();
      const path = join(directory, entry.name);
      if (!(await insideRepository(path, repositoryRoot))) {
        issues.push(
          `A repository entry in ${label} resolves outside the repository.`,
        );
        continue;
      }
      const info = await stat(path);
      if (info.isDirectory()) {
        await visit(path, [...parts, entry.name], depth + 1);
        continue;
      }
      if (!info.isFile() || !folder.includes(entry.name)) continue;
      if (Object.keys(hashes).length >= maxFiles) {
        issues.push(`The repository has too many ${label} to review.`);
        return;
      }
      if (info.size > maxFileBytes) {
        issues.push(`A repository entry in ${label} is too large to review.`);
        continue;
      }
      hashes[folder.entryName(parts, entry.name)] = createHash('sha256')
        .update(await readFile(path, { signal }))
        .digest('hex');
    }
  };
  try {
    if (await insideRepository(root, repositoryRoot)) await visit(root, [], 0);
    else issues.push(`The repository ${label} resolve outside the repository.`);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!missing(error))
      issues.push(`The repository ${label} could not be read.`);
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
  const folders = await Promise.all(
    reviewedFolders.map(async reviewed => {
      const path = join(folder, reviewed.path);
      const hashes = await folderHashes(
        reviewed,
        path,
        repositoryRoot,
        issues,
        signal,
      );
      return { reviewed, path, hashes };
    }),
  );
  const definitions: ProjectFileDefinition[] = [];
  const sources: { path: string; sections: ConfigTable }[] = [];
  for (const { reviewed, path, hashes } of folders) {
    const names = Object.keys(hashes);
    if (!names.length) continue;
    definitions.push({
      id: reviewed.id,
      name: reviewed.path.replaceAll('\\', '/'),
      detail: `${reviewed.label}: ${names.join(', ')}`.slice(0, detailChars),
      config: hashes,
    });
    sources.push({ path, sections: { [reviewed.id]: hashes } });
  }
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
            detailChars,
          ),
        config: rest,
        launches: rawReviewLaunch,
      });
  }
  return { definitions, sources };
};
