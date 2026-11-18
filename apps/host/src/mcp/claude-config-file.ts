import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigTable } from './scoped-config';

const runDirectoryPattern =
  /^mcp-run-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;

function removeRunDirectory(path: string) {
  return rm(path, { recursive: true, force: true, maxRetries: 3 });
}

export function sweepClaudeRunConfigs(directory: string) {
  for (const name of readdirSync(directory))
    if (runDirectoryPattern.test(name))
      rmSync(join(directory, name), {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
}

export async function writeClaudeRunConfig(
  dataDirectory: string,
  servers: ConfigTable,
  settings: ConfigTable,
) {
  const directory = join(dataDirectory, 'mcp-run-' + randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const dispose = () => removeRunDirectory(directory);
  const mcpPath = join(directory, 'mcp.json');
  const settingsPath = join(directory, 'settings.json');
  try {
    const options = { mode: 0o600, flag: 'wx' };
    await writeFile(mcpPath, JSON.stringify({ mcpServers: servers }), options);
    await writeFile(settingsPath, JSON.stringify(settings), options);
    return { mcpPath, settingsPath, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
