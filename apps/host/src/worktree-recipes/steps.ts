import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  worktreeRecipeLimits,
  type WorktreeRecipeRun,
  type WorktreeRecipeSnapshot,
  type WorktreeRecipeStep,
} from '@nesvo/contracts';
import { prepareShell, type StepShell } from '../workflows/steps/command';
import {
  OwnedProcessError,
  TailBuffer,
  runOwnedProcess,
} from '../workflows/steps/process';
import { runGit } from '../workspace/isolation';
import { copyWorktreeIncludes } from '../workspace/worktree-files';

const LIST_TIMEOUT_MS = 30_000;
const LIST_OUTPUT_BYTES = 1024 * 1024;

export const emptyStep = (
  kind: WorktreeRecipeStep['kind'],
): WorktreeRecipeStep => ({
  kind,
  status: 'pending',
  startedAt: null,
  completedAt: null,
  exitCode: null,
  output: '',
  truncated: false,
});

export const copyRecipeFiles = async (
  dataDirectory: string,
  source: string,
  target: string,
  recipe: WorktreeRecipeSnapshot,
  signal: AbortSignal,
): Promise<NonNullable<WorktreeRecipeRun['copied']>> => {
  if (!recipe.copy.patterns.length)
    return { copied: 0, skipped: 0, bytes: 0, incomplete: false };
  const scratch = join(dataDirectory, 'worktree-recipe-patterns');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const patternFile = join(scratch, `${randomUUID()}.patterns`);
  writeFileSync(patternFile, `${recipe.copy.patterns.join('\n')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    const listed = await runGit({
      args: [
        'ls-files',
        '--others',
        '--ignored',
        '-z',
        `--exclude-from=${patternFile}`,
      ],
      cwd: source,
      timeoutMs: LIST_TIMEOUT_MS,
      maxOutputBytes: LIST_OUTPUT_BYTES,
      signal,
    });
    if (listed.code !== 0)
      return { copied: 0, skipped: 0, bytes: 0, incomplete: true };
    const paths = listed.stdout
      .split('\0')
      .slice(0, -1)
      .filter(path => path && !path.includes('�'));
    const result = copyWorktreeIncludes(source, target, paths, {
      maxFiles: recipe.copy.maxFiles,
      maxBytes: recipe.copy.maxBytes,
    });
    return {
      copied: result.copied,
      skipped: result.skipped,
      bytes: result.bytes,
      incomplete: listed.outputTruncated,
    };
  } finally {
    unlinkSync(patternFile);
  }
};

export const commandEnvironment = (
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value == null ||
      name.toUpperCase().startsWith('NESVO_') ||
      name === 'ELECTRON_RUN_AS_NODE'
    )
      continue;
    env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
};

type CommandParams = {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  signal: AbortSignal;
  onOutput: (output: string, truncated: boolean) => void;
};

export const runRecipeCommand = async ({
  command,
  cwd,
  env,
  timeoutSeconds,
  signal,
  onOutput,
}: CommandParams): Promise<
  Pick<WorktreeRecipeStep, 'status' | 'exitCode' | 'output' | 'truncated'>
> => {
  const output = new TailBuffer(worktreeRecipeLimits.output);
  let received = 0;
  const push = (chunk: Buffer) => {
    received += chunk.length;
    output.push(chunk);
    onOutput(output.text(), received > worktreeRecipeLimits.output);
  };
  let shell: StepShell | null = null;
  try {
    shell = await prepareShell(command);
    const result = await runOwnedProcess({
      command: shell.command,
      args: shell.args,
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
      cwd,
      env,
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: worktreeRecipeLimits.output,
      signal,
      onStdout: push,
      onStderr: push,
    });
    return {
      status: signal.aborted
        ? 'stopped'
        : result.timedOut
          ? 'timed-out'
          : result.code === 0
            ? 'completed'
            : 'failed',
      exitCode: result.code,
      output: output.text(),
      truncated: received > worktreeRecipeLimits.output,
    };
  } catch (error) {
    const message =
      error instanceof OwnedProcessError
        ? error.message
        : 'The command could not start.';
    return {
      status: signal.aborted ? 'stopped' : 'failed',
      exitCode: null,
      output: `${output.text()}${message}`.slice(-worktreeRecipeLimits.output),
      truncated: received > worktreeRecipeLimits.output,
    };
  } finally {
    await shell?.dispose().catch(() => undefined);
  }
};
