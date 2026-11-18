import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { terminateGraceMs, trackProcessTree, wait } from './terminate-tree';

export type OwnedProcessOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: string | Buffer;
  captureStdoutBytes?: boolean;
  onStdout?: (chunk: string) => void;
};

export type OwnedProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stdoutBytes?: Buffer;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
};

export type OwnedProcessErrorCode =
  'spawn-failed' | 'cancelled' | 'unconfirmed-close';

export class OwnedProcessError extends Error {
  readonly code: OwnedProcessErrorCode;
  readonly systemCode: string | null;

  constructor(
    code: OwnedProcessErrorCode,
    message: string,
    systemCode: string | null = null,
  ) {
    super(message);
    this.name = 'OwnedProcessError';
    this.code = code;
    this.systemCode = systemCode;
  }
}

type BoundedOutput = {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
};

function capture(output: BoundedOutput, chunk: Buffer, limit: number): Buffer {
  const room = Math.max(0, limit - output.bytes);
  let end = Math.min(room, chunk.length);
  if (end < chunk.length) {
    output.truncated = true;
    while (end > 0 && (chunk[end]! & 0xc0) === 0x80) end--;
  }
  const kept = end < chunk.length ? chunk.subarray(0, end) : chunk;
  if (kept.length > 0) {
    output.chunks.push(kept);
    output.bytes += kept.length;
  }
  return kept;
}

function boundedOutput(): BoundedOutput {
  return { chunks: [], bytes: 0, truncated: false };
}

export function runOwnedProcess(
  options: OwnedProcessOptions,
): Promise<OwnedProcessResult> {
  const { signal } = options;
  if (signal?.aborted)
    return Promise.reject(
      new OwnedProcessError('cancelled', 'The process was cancelled.'),
    );
  const started = performance.now();
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  };
  const args = [...options.args];
  const child =
    options.stdin === undefined
      ? spawn(options.command, args, {
          ...spawnOptions,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(options.command, args, { ...spawnOptions, stdio: 'pipe' });
  const stdout = boundedOutput();
  const stderr = boundedOutput();
  const decoder = new StringDecoder('utf8');
  let hasExited = false;
  let hasClosed = false;
  let timedOut = false;
  let cancelled = false;
  let cleanup: Promise<void> | null = null;
  let closeResolve: (exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>(resolve => {
    closeResolve = resolve;
  });
  const tree = trackProcessTree(child, {
    hasExited: () => hasExited,
    hasClosed: () => hasClosed,
  });
  const stop = (): Promise<void> => {
    cleanup ??= (async () => {
      await tree.terminate(closed);
      if (!hasClosed) {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        await Promise.race([closed, wait(terminateGraceMs)]);
      }
    })();
    return cleanup;
  };
  return new Promise<OwnedProcessResult>((resolve, reject) => {
    let settled = false;
    const settle = (result: OwnedProcessResult | OwnedProcessError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tree.stopTracking();
      signal?.removeEventListener('abort', cancel);
      if (result instanceof OwnedProcessError) reject(result);
      else resolve(result);
    };
    const finish = async () => {
      await stop();
      if (!hasClosed) {
        settle(
          new OwnedProcessError(
            'unconfirmed-close',
            'The process did not close after cleanup.',
          ),
        );
        return;
      }
      const exit = await closed;
      if (cancelled) {
        settle(
          new OwnedProcessError('cancelled', 'The process was cancelled.'),
        );
        return;
      }
      const stdoutBytes = Buffer.concat(stdout.chunks);
      settle({
        code: exit.code,
        signal: exit.signal,
        stdout: options.captureStdoutBytes ? '' : stdoutBytes.toString('utf8'),
        ...(options.captureStdoutBytes ? { stdoutBytes } : {}),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        timedOut,
        outputTruncated: stdout.truncated || stderr.truncated,
        durationMs: Math.round(performance.now() - started),
      });
    };
    const cancel = () => {
      if (hasExited || hasClosed) return;
      cancelled = true;
      void stop();
    };
    const timer = setTimeout(() => {
      if (hasExited || hasClosed) return;
      timedOut = true;
      void stop();
    }, options.timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', error => {
      if (child.pid !== undefined) {
        void stop();
        return;
      }
      settle(
        new OwnedProcessError(
          'spawn-failed',
          'The process could not be started.',
          (error as NodeJS.ErrnoException).code ?? null,
        ),
      );
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const kept = capture(stdout, chunk, options.maxOutputBytes);
      if (kept.length > 0 && options.onStdout) {
        const text = decoder.write(kept);
        if (text) options.onStdout(text);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      capture(stderr, chunk, options.maxOutputBytes);
    });
    child.stdout.on('error', () => void stop());
    child.stderr.on('error', () => void stop());
    child.stdin?.on('error', () => {});
    child.once('exit', () => {
      hasExited = true;
      void stop();
    });
    child.once('close', (code, exitSignal) => {
      hasClosed = true;
      const rest = decoder.end();
      if (rest && options.onStdout) options.onStdout(rest);
      closeResolve({ code, signal: exitSignal });
      if (child.pid !== undefined) void finish();
    });
    child.stdin?.end(options.stdin);
  });
}
