import { mkdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import type {
  WorktreeRecipeResources,
  WorktreeRecipeSnapshot,
} from '@nesvo/contracts';

const RESERVED_PORTS = new Set([8789, 9223]);
const TEMP_ROOT = 'worktree-recipe-temp';
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

const canBind = (port: number, host: string) =>
  new Promise<boolean>(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) =>
      resolve(error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL'),
    );
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });

export const isPortFree = async (port: number) =>
  (await canBind(port, '127.0.0.1')) &&
  (await canBind(port, '0.0.0.0')) &&
  (await canBind(port, '::'));

export const allocatePorts = async (
  count: number,
  range: { from: number; to: number },
  taken: ReadonlySet<number>,
  signal: AbortSignal,
) => {
  const ports: number[] = [];
  for (let port = range.from; port <= range.to && ports.length < count; port++) {
    if (signal.aborted) throw new Error('Allocation stopped.');
    if (RESERVED_PORTS.has(port) || taken.has(port)) continue;
    if (await isPortFree(port)) ports.push(port);
  }
  if (ports.length < count)
    throw new Error(
      `Only ${ports.length} of ${count} ports are free in ${range.from}–${range.to}. Widen the range or release other sessions.`,
    );
  return ports;
};

export const resourceTag = (id: string) =>
  `nesvo-${id.replace(/-/g, '').slice(0, 12).toLowerCase()}`;

const tempRoot = (dataDirectory: string) =>
  join(realpathSync.native(dataDirectory), TEMP_ROOT);

export const tempDirectoryFor = (dataDirectory: string, id: string) => {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid resource identifier.');
  return join(tempRoot(dataDirectory), id.toLowerCase());
};

export const createResources = async (
  dataDirectory: string,
  id: string,
  recipe: WorktreeRecipeSnapshot,
  taken: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<WorktreeRecipeResources> => {
  const ports = await allocatePorts(
    recipe.resources.ports,
    recipe.resources.portRange,
    taken,
    signal,
  );
  let tempDirectory: string | null = null;
  if (recipe.resources.tempDirectory) {
    tempDirectory = tempDirectoryFor(dataDirectory, id);
    mkdirSync(dirname(tempDirectory), { recursive: true, mode: 0o700 });
    mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
  }
  return {
    ports,
    tag: recipe.resources.tag ? resourceTag(id) : null,
    tempDirectory,
  };
};

export const removeTempDirectory = async (
  dataDirectory: string,
  id: string,
  resources: WorktreeRecipeResources,
) => {
  if (!resources.tempDirectory) return;
  const expected = tempDirectoryFor(dataDirectory, id);
  if (resources.tempDirectory !== expected)
    throw new Error('The temporary directory is outside the recipe store.');
  await rm(expected, { recursive: true, force: true, maxRetries: 3 });
};
