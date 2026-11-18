import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { lockDataDirectory } from '@nesvo/host';

const profileData =
  /^(?:appearance\.json|background\.json|window-state\.json|computers\.json|computer-cache\.json)(?:\.[a-z0-9-]+\.tmp)?$|^(?:mobile|work-laptop-mode)$/i;
const hostData =
  /^(?:nesvo\.sqlite(?:-(?:wal|shm|journal))?|nesvo\.sqlite\.(?:v\d+|backup-[\dTZ-]+)\.bak(?:\.[a-z0-9-]+\.tmp)?|attachments|(?:workflow|pipeline)-(?:specs|evidence)|mcp-run-[a-f0-9-]{36})$/i;
const logData = /^(?:main|host)(?:\.\d+)?\.log$/;

const optionalStat = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });

async function verifyDirectory(directory: string) {
  const info = await optionalStat(directory);
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new Error('The data location is not a regular directory.');
}

async function eraseMatching(directory: string, names: RegExp) {
  const contents = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const name of contents.filter(name => names.test(name)))
    await rm(join(directory, name), { recursive: true, force: true });
}

export async function deleteLocalData(directory: string, logs: string) {
  const host = join(directory, 'host');
  await verifyDirectory(directory);
  await verifyDirectory(host);
  await verifyDirectory(logs);
  const lock = await optionalStat(join(host, 'ownership.sqlite'));
  if (lock && (!lock.isFile() || lock.isSymbolicLink()))
    throw new Error('The host lock is not a regular file.');
  const ownership = lockDataDirectory(host);
  try {
    await eraseMatching(host, hostData);
    await eraseMatching(directory, profileData);
    await eraseMatching(logs, logData);
  } finally {
    ownership.close();
  }
}
