import { tmpdir } from 'node:os';
import {
  OwnedProcessError,
  runOwnedProcess,
  type OwnedProcessResult,
} from '../process/owned-process';

const FOLDER_CHECK_TIMEOUT_MS = 5000;
const MAX_CHECK_OUTPUT_BYTES = 64 * 1024;

export class FolderError extends Error {
  constructor(
    readonly code: 'invalid-directory' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

function resolveFolderInChild(): void {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const requested = process.argv[1] ?? '';
  let folder: string | null = null;
  try {
    if (path.isAbsolute(requested) && fs.statSync(requested).isDirectory())
      folder = fs.realpathSync(requested);
  } catch {
    folder = null;
  }
  process.stdout.write(JSON.stringify({ folder }));
}

function checkerEnvironment(): NodeJS.ProcessEnv {
  return {
    ELECTRON_RUN_AS_NODE: '1',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

function reportedFolder(result: OwnedProcessResult): string | null | undefined {
  if (result.timedOut || result.outputTruncated || result.code !== 0)
    return undefined;
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (value === null || typeof value !== 'object' || !('folder' in value))
      return undefined;
    return typeof value.folder === 'string' || value.folder === null
      ? value.folder
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveFolder(
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  let result: OwnedProcessResult;
  try {
    result = await runOwnedProcess({
      command: process.execPath,
      args: ['-e', `(${resolveFolderInChild.toString()})()`, '--', directory],
      cwd: tmpdir(),
      env: checkerEnvironment(),
      timeoutMs: FOLDER_CHECK_TIMEOUT_MS,
      maxOutputBytes: MAX_CHECK_OUTPUT_BYTES,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof OwnedProcessError)
      throw new FolderError('unavailable', 'The folder could not be checked.');
    throw error;
  }
  const folder = reportedFolder(result);
  if (folder === undefined)
    throw new FolderError(
      'unavailable',
      'The folder could not be checked in time.',
    );
  if (folder === null)
    throw new FolderError(
      'invalid-directory',
      'The directory does not exist or cannot be accessed. Enter its absolute path.',
    );
  return folder;
}
