import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  descendantScanMs,
  recordDescendants,
  signalRecorded,
} from '../providers/process-tree';

const terminateGraceMs = 300;
const cleanupTimeoutMs = 4_000;

export type OwnedProcessOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
};

export type OwnedProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
};

export type OwnedProcessErrorCode =
  | 'spawn-failed'
  | 'cancelled'
  | 'unconfirmed-close';

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

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref());
}

async function taskkill(pid: number): Promise<void> {
  await new Promise<void>(resolve => {
    const killer = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      killer.kill();
      resolve();
    }, cleanupTimeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    killer.once('error', finish);
    killer.once('close', finish);
  });
}

function capture(output: BoundedOutput, chunk: Buffer, limit: number): Buffer {
  const room = Math.max(0, limit - output.bytes);
  const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
  if (kept.length < chunk.length) output.truncated = true;
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
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = boundedOutput();
  const stderr = boundedOutput();
  const decoder = new StringDecoder('utf8');
  const descendants = new Map<number, number>();
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
  const recordOwnedDescendants = () => {
    if (child.pid && !hasExited) recordDescendants(child.pid, descendants);
  };
  const descendantScan =
    process.platform === 'linux' && child.pid
      ? setInterval(recordOwnedDescendants, descendantScanMs).unref()
      : null;
  const signalGroup = (kill: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, kill);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !hasClosed)
        child.kill(kill);
    }
    signalRecorded(descendants, kill);
  };
  const stop = (): Promise<void> => {
    cleanup ??= (async () => {
      if (child.pid) {
        if (process.platform === 'win32') {
          if (!hasExited && !hasClosed) await taskkill(child.pid);
        } else {
          recordOwnedDescendants();
          signalGroup('SIGTERM');
          await Promise.race([closed, wait(terminateGraceMs)]);
          signalGroup('SIGKILL');
        }
      }
      await Promise.race([closed, wait(cleanupTimeoutMs)]);
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
      if (descendantScan) clearInterval(descendantScan);
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
        settle(new OwnedProcessError('cancelled', 'The process was cancelled.'));
        return;
      }
      settle({
        code: exit.code,
        signal: exit.signal,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        timedOut,
        outputTruncated: stdout.truncated || stderr.truncated,
        durationMs: Math.round(performance.now() - started),
      });
    };
    const cancel = () => {
      cancelled = true;
      void stop();
    };
    const timer = setTimeout(() => {
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
    child.once('exit', () => {
      hasExited = true;
      void stop();
    });
    child.once('close', (code, exitSignal) => {
      hasClosed = true;
      closeResolve({ code, signal: exitSignal });
      if (child.pid !== undefined) void finish();
    });
  });
}
