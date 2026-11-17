import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EMPTY_CLAUDE_MCP_CONFIG = '{"mcpServers":{}}';

export type ClaudeMcpConfig = {
  argument: string;
  dispose: () => Promise<void>;
};

export const writeClaudeMcpConfig = async (
  servers: Readonly<Record<string, Record<string, unknown>>>,
): Promise<ClaudeMcpConfig> => {
  if (!Object.keys(servers).length)
    return { argument: EMPTY_CLAUDE_MCP_CONFIG, dispose: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), 'nesvo-mcp-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const path = join(directory, 'mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: servers }), {
      mode: 0o600,
      flag: 'wx',
    });
    return { argument: path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
};
