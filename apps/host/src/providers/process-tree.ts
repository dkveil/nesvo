import { readdirSync, readFileSync } from 'node:fs';

export const descendantScanMs = 1_000;

type ProcessStat = { parent: number; startTime: number };

function readStat(pid: number): ProcessStat | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const parent = Number(fields[1]);
    const startTime = Number(fields[19]);
    return Number.isInteger(parent) && Number.isInteger(startTime)
      ? { parent, startTime }
      : null;
  } catch {
    return null;
  }
}

export function recordDescendants(
  root: number,
  recorded: Map<number, number>,
): void {
  if (process.platform !== 'linux') return;
  const rootStat = readStat(root);
  if (!rootStat) return;
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return;
  }
  const children = new Map<number, { pid: number; startTime: number }[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readStat(pid);
    if (!stat || stat.startTime < rootStat.startTime) continue;
    children.set(stat.parent, [
      ...(children.get(stat.parent) ?? []),
      { pid, startTime: stat.startTime },
    ]);
  }
  const visit = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      recorded.set(child.pid, child.startTime);
      visit(child.pid);
    }
  };
  visit(root);
}

export function signalRecorded(
  recorded: Map<number, number>,
  signal: NodeJS.Signals,
): void {
  for (const [pid, startTime] of recorded) {
    if (readStat(pid)?.startTime !== startTime) {
      recorded.delete(pid);
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

export function processStartTime(pid: number): number | null {
  return readStat(pid)?.startTime ?? null;
}
