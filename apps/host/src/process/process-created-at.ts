import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const QUERY_TIMEOUT_MS = 10_000;

const run = promisify(execFile);

export const processCreatedAt = async (pid: number): Promise<number | null> => {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1)
    return null;
  try {
    const { stdout } = await run(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C' }, timeout: QUERY_TIMEOUT_MS },
    );
    const createdAt = Date.parse(stdout.trim());
    return Number.isFinite(createdAt) ? createdAt : null;
  } catch {
    return null;
  }
};
