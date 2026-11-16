import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  descendantScanMs,
  recordDescendants,
  signalRecorded,
} from '../../providers/process-tree';

export type OwnedProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  windowsVerbatimArguments?: boolean;
  onSpawn?: (pid: number) => void;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
};

export type OwnedProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export class OwnedProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedProcessError';
  }
}

const cleanupTimeoutMs = 4_000;
const graceMs = 300;

const wait = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms).unref());

export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const taskkill = (pid: number) =>
  new Promise<void>(resolve => {
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

export const runOwnedProcess = (
  options: OwnedProcessOptions,
): Promise<OwnedProcessResult> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    if (options.signal.aborted) {
      reject(new OwnedProcessError('The process was cancelled before it started.'));
      return;
    }
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) options.onSpawn?.(child.pid);
    const stdout = new TailBuffer(options.maxOutputBytes);
    const stderr = new TailBuffer(options.maxOutputBytes);
    const descendants = new Map<number, number>();
    let exited = false;
    let closed = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let cleanup: Promise<void> | null = null;
    let markClosed: () => void = () => undefined;
    const closing = new Promise<void>(done => {
      markClosed = done;
    });
    const scan =
      process.platform === 'linux' && child.pid
        ? setInterval(() => {
            if (child.pid && !exited) recordDescendants(child.pid, descendants);
          }, descendantScanMs).unref()
        : null;
    const signalGroup = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !closed)
          child.kill(name);
      }
      signalRecorded(descendants, name);
    };
    const stop = () => {
      cleanup ??= (async () => {
        if (child.pid) {
          if (process.platform === 'win32') {
            if (!exited && !closed) await taskkill(child.pid);
          } else {
            if (!exited) recordDescendants(child.pid, descendants);
            signalGroup('SIGTERM');
            await Promise.race([closing, wait(graceMs)]);
            signalGroup('SIGKILL');
          }
        }
        await Promise.race([closing, wait(cleanupTimeoutMs)]);
        if (!closed) {
          child.kill('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
        }
      })();
      return cleanup;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, options.timeoutMs);
    const abort = () => void stop();
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      options.onStderr?.(chunk);
    });
    child.stdout.on('error', () => void stop());
    child.stderr.on('error', () => void stop());
    child.once('error', error => {
      spawnError = error;
    });
    child.once('exit', () => {
      exited = true;
      if (scan) clearInterval(scan);
      void stop();
    });
    child.once('close', (code, signal) => {
      closed = true;
      exited = true;
      markClosed();
      if (scan) clearInterval(scan);
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      void (async () => {
        await stop();
        if (spawnError && !child.pid) {
          reject(
            new OwnedProcessError(`The process could not start: ${spawnError.message}`),
          );
          return;
        }
        resolve({
          code,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
          durationMs: Date.now() - started,
        });
      })();
    });
  });
