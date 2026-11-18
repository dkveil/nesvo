import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  descendantScanMs,
  recordDescendants,
  signalRecorded,
} from '../providers/process-tree';

export const cleanupTimeoutMs = 4_000;
export const terminateGraceMs = 300;

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref());
}

function taskkill(pid: number): Promise<void> {
  return new Promise(resolve => {
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

export function trackProcessTree(
  child: ChildProcess,
  {
    hasExited,
    hasClosed,
    checkWindowsExitCodes = false,
  }: {
    hasExited: () => boolean;
    hasClosed: () => boolean;
    checkWindowsExitCodes?: boolean;
  },
) {
  const descendants = new Map<number, number>();
  const record = () => {
    if (child.pid && !hasExited()) recordDescendants(child.pid, descendants);
  };
  const scan =
    process.platform === 'linux' && child.pid
      ? setInterval(record, descendantScanMs).unref()
      : null;
  const stopTracking = () => {
    if (scan) clearInterval(scan);
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !hasClosed())
        child.kill(signal);
    }
    signalRecorded(descendants, signal);
  };
  const terminate = async (closed: Promise<unknown>) => {
    if (child.pid) {
      if (process.platform === 'win32') {
        if (
          !hasExited() &&
          !hasClosed() &&
          (!checkWindowsExitCodes ||
            (child.exitCode === null && child.signalCode === null))
        )
          await taskkill(child.pid);
      } else {
        record();
        signalGroup('SIGTERM');
        await Promise.race([closed, wait(terminateGraceMs)]);
        signalGroup('SIGKILL');
      }
    }
    await Promise.race([closed, wait(cleanupTimeoutMs)]);
  };
  return { record, stopTracking, terminate };
}
