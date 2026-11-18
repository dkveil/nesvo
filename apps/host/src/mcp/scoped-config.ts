import { basename, dirname, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { readConfigFile } from './config-file';

export const tableSchema = z.record(z.string(), z.unknown());
export type ConfigTable = Record<string, unknown>;

export async function repositoryFolders(directory: string) {
  const folders = [await realpath(directory)];
  while (folders.length < 64) {
    const folder = folders.at(-1)!;
    if (
      await stat(join(folder, '.git')).catch(error => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      })
    )
      return folders;
    const parent = dirname(folder);
    if (parent === folder) return folders.slice(0, 1);
    folders.push(parent);
  }
  throw new Error('The repository configuration hierarchy is too deep.');
}

export async function configTable(
  path: string,
  issues: string[],
  signal?: AbortSignal,
  maxBytes = 1024 * 1024,
): Promise<ConfigTable> {
  const file = await readConfigFile(path, maxBytes, signal);
  if (file.status === 'missing') return {};
  if (file.status === 'read') {
    try {
      return tableSchema.parse(
        path.endsWith('.toml') ? parse(file.text) : JSON.parse(file.text),
      );
    } catch {
      issues.push(`The ${basename(path)} configuration is invalid.`);
      return {};
    }
  }
  issues.push(`The ${basename(path)} configuration could not be read.`);
  return {};
}

export function section(
  config: ConfigTable,
  name: string,
  issues: string[],
): ConfigTable {
  if (!(name in config)) return {};
  const table = tableSchema.safeParse(config[name]);
  if (table.success) return table.data;
  issues.push(`The ${name} configuration is invalid.`);
  return {};
}

export const directoryKey = (path: string): string => {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export function mergeHooks(sources: readonly ConfigTable[]): ConfigTable {
  const entries = new Map<string, unknown[]>();
  for (const source of sources)
    for (const [event, groups] of Object.entries(source)) {
      if (!Array.isArray(groups)) throw new Error('Invalid hook event.');
      entries.set(event, [...(entries.get(event) ?? []), ...groups]);
    }
  return Object.fromEntries(entries);
}
