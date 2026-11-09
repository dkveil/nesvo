import { readdirSync, readFileSync } from 'node:fs';

function parentPid(pid: string): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(parent) ? parent : null;
  } catch {
    return null;
  }
}

export function descendantPids(root: number): number[] {
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const parent = parentPid(entry);
    if (parent === null) continue;
    children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
  }
  const descendants: number[] = [];
  const visit = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(root);
  return descendants;
}

export function signalProcesses(
  pids: Iterable<number>,
  signal: NodeJS.Signals,
): void {
  for (const pid of pids)
    try {
      process.kill(pid, signal);
    } catch {}
}
