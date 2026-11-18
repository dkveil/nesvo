import {
  runningAppLimits,
  type RunningApp,
  type RunningAppMatch,
} from '@nesvo/contracts';
import type { ProviderProcess } from '../process/provider-processes';
import type { ListeningSocket, ProcessEntry } from './scan';

const MAX_ANCESTOR_DEPTH = 32;
const PROVIDER_START_TOLERANCE_MS = 10_000;
const CHILD_START_TOLERANCE_MS = 1_000;

export type SessionFolder = { id: string; directory: string };

type Attribution = { sessionId: string; match: RunningAppMatch };

type AttributeInput = {
  sockets: readonly ListeningSocket[];
  processes: ReadonlyMap<number, ProcessEntry>;
  sessions: readonly SessionFolder[];
  providerProcess: (pid: number) => ProviderProcess | undefined;
  caseInsensitivePaths: boolean;
};

function isOwnedBy(
  owner: ProviderProcess,
  entry: ProcessEntry | undefined,
  child: ProcessEntry | undefined,
): boolean {
  if (entry)
    return (
      entry.startedAt === null ||
      Math.abs(entry.startedAt - owner.recordedAt) <=
        PROVIDER_START_TOLERANCE_MS
    );
  return (
    !child ||
    child.startedAt === null ||
    child.startedAt >= owner.recordedAt - CHILD_START_TOLERANCE_MS
  );
}

function attributeByProcess(
  pid: number,
  processes: ReadonlyMap<number, ProcessEntry>,
  providerProcess: AttributeInput['providerProcess'],
  sessionIds: ReadonlySet<string>,
): string | null {
  let current = pid;
  let child: ProcessEntry | undefined;
  const visited = new Set<number>();
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (current <= 0 || visited.has(current)) return null;
    visited.add(current);
    const entry = processes.get(current);
    const owner = providerProcess(current);
    if (
      owner &&
      sessionIds.has(owner.sessionId) &&
      isOwnedBy(owner, entry, child)
    )
      return owner.sessionId;
    if (!entry) return null;
    child = entry;
    current = entry.parent;
  }
  return null;
}

function normalizePath(path: string, caseInsensitive: boolean): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? unified.toLowerCase() : unified;
}

function attributeByFolder(
  directory: string | null,
  sessions: readonly SessionFolder[],
  caseInsensitive: boolean,
): string | null {
  if (!directory) return null;
  const target = normalizePath(directory, caseInsensitive);
  let best: { length: number; ids: string[] } | null = null;
  for (const session of sessions) {
    const folder = normalizePath(session.directory, caseInsensitive);
    if (!folder || (target !== folder && !target.startsWith(`${folder}/`)))
      continue;
    if (!best || folder.length > best.length)
      best = { length: folder.length, ids: [session.id] };
    else if (folder.length === best.length) best.ids.push(session.id);
  }
  return best?.ids.length === 1 ? (best.ids[0] ?? null) : null;
}

function attribute(
  pid: number,
  input: AttributeInput,
  sessionIds: ReadonlySet<string>,
): Attribution | null {
  const byProcess = attributeByProcess(
    pid,
    input.processes,
    input.providerProcess,
    sessionIds,
  );
  if (byProcess) return { sessionId: byProcess, match: 'process' };
  const byFolder = attributeByFolder(
    input.processes.get(pid)?.directory ?? null,
    input.sessions,
    input.caseInsensitivePaths,
  );
  return byFolder ? { sessionId: byFolder, match: 'folder' } : null;
}

function preferredAddress(addresses: readonly string[]): string {
  return (
    addresses.find(address => address === '127.0.0.1') ??
    addresses.find(address => address === '0.0.0.0') ??
    addresses[0] ??
    ''
  );
}

export function attributeRunningApps(input: AttributeInput): RunningApp[] {
  const sessionIds = new Set(input.sessions.map(session => session.id));
  const grouped = new Map<
    string,
    { pid: number; port: number; addresses: string[] }
  >();
  for (const socket of input.sockets) {
    const key = `${socket.pid}:${socket.port}`;
    const group = grouped.get(key);
    if (group) group.addresses.push(socket.address);
    else
      grouped.set(key, {
        pid: socket.pid,
        port: socket.port,
        addresses: [socket.address],
      });
  }
  const cache = new Map<number, Attribution | null>();
  const apps: RunningApp[] = [];
  for (const group of grouped.values()) {
    if (!cache.has(group.pid))
      cache.set(group.pid, attribute(group.pid, input, sessionIds));
    const attribution = cache.get(group.pid);
    if (!attribution) continue;
    apps.push({
      port: group.port,
      address: preferredAddress(group.addresses).slice(0, 64),
      pid: group.pid,
      name: (input.processes.get(group.pid)?.name ?? '').slice(
        0,
        runningAppLimits.nameLength,
      ),
      ...attribution,
    });
  }
  return apps
    .sort((left, right) => left.port - right.port)
    .slice(0, runningAppLimits.apps);
}
