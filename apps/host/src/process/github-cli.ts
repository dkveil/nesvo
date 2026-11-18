import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { OwnedProcessError, runOwnedProcess } from './owned-process';

const maxConcurrentProcesses = 6;
const maxQueuedProcesses = 32;
const installation =
  'Install the GitHub CLI (gh) on this computer and run gh auth login.';
const signIn = 'Sign in with gh auth login on this computer.';
const forwarded = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK',
];

export class PullRequestError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'unavailable' | 'busy' | 'not-found',
    message: string,
  ) {
    super(message);
  }
}

function executableFile(
  file: string,
  mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK,
): boolean {
  try {
    accessSync(file, mode);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function ghExecutable(): { command: string; prefix: string[] } {
  const override = process.env.NESVO_GH_EXECUTABLE;
  if (override) {
    if (!isAbsolute(override))
      throw new PullRequestError(
        'unavailable',
        'NESVO_GH_EXECUTABLE must be an absolute path.',
      );
    if (/\.(?:js|mjs|cjs)$/i.test(override)) {
      if (!executableFile(override, constants.R_OK))
        throw new PullRequestError('unavailable', installation);
      return { command: process.execPath, prefix: [override] };
    }
    if (executableFile(override)) return { command: override, prefix: [] };
    throw new PullRequestError('unavailable', installation);
  }
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const entry = directory.replace(/^"|"$/g, '');
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    if (executableFile(candidate)) return { command: candidate, prefix: [] };
  }
  throw new PullRequestError('unavailable', installation);
}

function ghEnvironment(
  fixture: boolean,
  inferHost: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_PAGER: '',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of forwarded) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  if (!inferHost) env.GH_HOST = 'github.com';
  if (fixture) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

const graphErrors = z.object({
  errors: z
    .array(z.object({ message: z.string(), type: z.string().optional() }))
    .min(1),
});

function ghError(
  code: number | null,
  stderr: string,
  apiAction?: GhOptions['apiAction'],
) {
  if (
    code === 4 ||
    /gh auth login|authentication required|bad credentials|http 401|requires authentication/i.test(
      stderr,
    )
  )
    return new PullRequestError('unavailable', signIn);
  if (
    /no pull requests found|could not resolve to (?:a |an )?(?:repository|pullrequest)|could not find (?:a |the )?(?:pull request|repository)|http 404|repository not found/i.test(
      stderr,
    )
  )
    return new PullRequestError(
      'not-found',
      'The GitHub repository or pull request was not found.',
    );
  const detail = stderr
    .trim()
    .split(/\r?\n/)
    .at(-1)
    ?.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\b(?:gh[pousr]_[\w-]+|github_pat_[\w-]+)\b/gi, '[redacted]')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(
      /\b(?:[\w-]*token|password|authorization|client_secret)\s*[:=]\s*[^\s,;]+/gi,
      '[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/]+@/gi, '$1[redacted]@')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .trim();
  const status = /(?:^gh: |\()HTTP (\d{3})\)?$/.exec(detail ?? '')?.[1];
  if (apiAction === 'merge' && status === '409')
    return new PullRequestError(
      'invalid-request',
      'The pull request head moved since you reviewed it. Refresh and review again.',
    );
  if (apiAction === 'merge' && status === '405') {
    const message = detail
      ?.replace(/^gh: /, '')
      .replace(/(?:^|\s*\()HTTP 405\)?$/, '')
      .slice(0, 300);
    return new PullRequestError(
      'invalid-request',
      `GitHub refused the merge: ${message || 'An immediate merge is unavailable.'}`,
    );
  }
  if (apiAction === 'review' && status === '422')
    return new PullRequestError(
      'invalid-request',
      `GitHub refused the review: ${detail?.replace(/^gh: /, '').replace(/(?:^|\s*\()HTTP 422\)?$/, '').slice(0, 300) || 'A comment may point outside the diff.'}`,
    );
  if (apiAction === 'line-comment' && status === '422')
    return new PullRequestError(
      'invalid-request',
      'GitHub could not comment on the selected line or commit. Refresh the diff and select a line or range in the current diff.',
    );
  return new PullRequestError(
    'unavailable',
    detail?.slice(0, 300) || 'The GitHub CLI command failed.',
  );
}

type GhOptions = {
  cwd?: string;
  inferHost?: boolean;
  stdin?: string;
  mutation?: boolean;
  apiAction?: 'merge' | 'line-comment' | 'review';
  maxOutputBytes?: number;
  noCurrentPullRequest?: boolean;
  signal?: AbortSignal;
};

function abortedRequest(signal: AbortSignal) {
  return new PullRequestError(
    'unavailable',
    signal.reason instanceof DOMException &&
      signal.reason.name === 'TimeoutError'
      ? 'The GitHub CLI request timed out.'
      : 'The GitHub CLI request was cancelled.',
  );
}

export class GitHubCli {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly signal: AbortSignal) {}

  private async acquire(signal: AbortSignal) {
    if (signal.aborted) throw abortedRequest(signal);
    if (this.active < maxConcurrentProcesses) {
      this.active++;
      return;
    }
    if (this.waiting.length >= maxQueuedProcesses)
      throw new PullRequestError(
        'busy',
        'Too many GitHub CLI requests. Try again shortly.',
      );
    await new Promise<void>((resolve, reject) => {
      const handOver = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(handOver);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(abortedRequest(signal));
      };
      this.waiting.push(handOver);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async run(args: string[], options: GhOptions = {}) {
    const signal = options.signal
      ? AbortSignal.any([this.signal, options.signal])
      : this.signal;
    await this.acquire(signal);
    try {
      if (signal.aborted) throw abortedRequest(signal);
      return await this.execute(args, options, signal);
    } finally {
      this.release();
    }
  }

  private async execute(
    args: string[],
    options: GhOptions,
    signal: AbortSignal,
  ) {
    const { command, prefix } = ghExecutable();
    try {
      const result = await runOwnedProcess({
        command,
        args: [...prefix, ...args],
        cwd: options.cwd ?? tmpdir(),
        env: ghEnvironment(prefix.length > 0, options.inferHost ?? false),
        timeoutMs: options.mutation ? 60_000 : 20_000,
        maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024,
        signal,
        stdin: options.stdin,
      });
      if (signal.aborted) throw abortedRequest(signal);
      if (result.timedOut)
        throw new PullRequestError(
          'unavailable',
          'The GitHub CLI request timed out.',
        );
      if (result.code !== 0) {
        if (
          options.noCurrentPullRequest &&
          result.code === 1 &&
          /^no pull requests found for branch\b/im.test(result.stderr)
        )
          return null;
        throw ghError(result.code, result.stderr, options.apiAction);
      }
      if (result.outputTruncated && (!options.mutation || args[0] === 'api'))
        throw new PullRequestError(
          'unavailable',
          'The GitHub CLI response exceeded its size limit.',
        );
      return result.stdout;
    } catch (error) {
      if (!(error instanceof OwnedProcessError)) throw error;
      if (signal.aborted) throw abortedRequest(signal);
      if (error.systemCode === 'ENOENT' && !executableFile(command))
        throw new PullRequestError('unavailable', installation);
      throw new PullRequestError(
        'unavailable',
        'The GitHub CLI process did not finish cleanly.',
      );
    }
  }

  async json<T>(
    schema: z.ZodType<T>,
    args: string[],
    options?: GhOptions,
  ): Promise<T> {
    const raw = await this.run(args, options);
    let value: unknown = null;
    if (raw !== null) {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new PullRequestError(
          'unavailable',
          'The GitHub CLI returned invalid JSON.',
        );
      }
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const parsed = graphErrors.safeParse(value);
      if (parsed.success) {
        const first = parsed.data.errors[0]!;
        if (first.type === 'NOT_FOUND')
          throw new PullRequestError(
            'not-found',
            'The GitHub repository or pull request was not found.',
          );
        throw ghError(null, first.message);
      }
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new PullRequestError(
        'unavailable',
        'The GitHub CLI returned an unexpected response.',
      );
    return parsed.data;
  }
}
