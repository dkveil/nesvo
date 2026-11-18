import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  sessionWorktreeSetupResultSchema,
  type RunSessionWorktreeSetupInput,
  type SessionWorktreeSetupResult,
} from '@nesvo/contracts';
import { runOwnedProcess } from '../process/owned-process';
import { readWorktreeFile } from './worktree-files';

const outputLimit = 16 * 1024;
const sha256 = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');

function setupStore(dataDirectory: string, create: boolean) {
  const root = join(
    realpathSync.native(dataDirectory),
    'session-worktree-setup',
  );
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(root)) return;
  if (realpathSync.native(root) !== root)
    throw new Error('Invalid setup data directory.');
  return root;
}

function readScript(projectDirectory: string) {
  try {
    const contents = readWorktreeFile(
      projectDirectory,
      '.nesvo/worktree-setup',
      64 * 1024,
    );
    new TextDecoder('utf-8', { fatal: true }).decode(contents);
    return { contents, sha256: sha256(contents) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      'Setup script must be a regular UTF-8 file of at most 64 KiB.',
    );
  }
}

function approvalName(gitDirectory: string, hash: string) {
  return `${sha256(gitDirectory)}-${hash}.approved`;
}

export function inspectWorktreeSetup(
  dataDirectory: string,
  id: string,
  projectDirectory: string,
  gitDirectory: string,
) {
  const store = setupStore(dataDirectory, false);
  const script = readScript(projectDirectory);
  let result: SessionWorktreeSetupResult | null = null;
  if (store) {
    try {
      result = sessionWorktreeSetupResultSchema.parse(
        JSON.parse(
          readWorktreeFile(store, `${id}.json`, 256 * 1024).toString('utf8'),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return {
    result,
    script: script && {
      sha256: script.sha256,
      approved:
        !!store &&
        existsSync(join(store, approvalName(gitDirectory, script.sha256))),
    },
  };
}

export async function executeWorktreeSetup(
  dataDirectory: string,
  worktree: string,
  projectDirectory: string,
  gitDirectory: string,
  input: RunSessionWorktreeSetupInput,
  signal: AbortSignal,
): Promise<SessionWorktreeSetupResult> {
  const script = readScript(projectDirectory);
  if (!script || script.sha256 !== input.sha256)
    throw new Error(
      'The setup script changed. Reopen it and review its new SHA-256.',
    );
  const store = setupStore(dataDirectory, true)!;
  const approval = join(store, approvalName(gitDirectory, script.sha256));
  if (!existsSync(approval)) {
    if (!input.approve)
      throw new Error('Approve this setup script before running it.');
    writeFileSync(approval, '', { flag: 'wx', mode: 0o600 });
  }

  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const name of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  let result: SessionWorktreeSetupResult;
  try {
    const processResult = await runOwnedProcess({
      command: process.execPath,
      args: ['--input-type=commonjs', '-'],
      cwd: worktree,
      stdin: script.contents,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: outputLimit,
      signal,
    });
    result = {
      sha256: script.sha256,
      status: processResult.timedOut
        ? 'timed-out'
        : processResult.code === 0
          ? 'completed'
          : 'failed',
      exitCode: processResult.code,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      truncated: processResult.outputTruncated,
    };
  } catch (error) {
    result = {
      sha256: script.sha256,
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Setup could not run.',
      truncated: false,
    };
  }
  const temporary = join(store, `${input.sessionId}-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, join(store, `${input.sessionId}.json`));
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return result;
}
