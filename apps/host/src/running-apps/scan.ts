import { readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runOwnedProcess } from '../process/owned-process';
import { PROVIDER_SESSION_VARIABLE } from '../process/provider-processes';
import { LinuxSockets } from './linux-sockets';
import {
  loopbackHost,
  parseNetstat,
  parseSocketAddress,
  parseTasklist,
  type ListeningSocket,
} from './listeners';
import { WINDOWS_PROCESS_SNAPSHOT } from './windows-processes';

export type { ListeningSocket } from './listeners';

const SCAN_TIMEOUT_MS = 10_000;
const MAX_SCAN_OUTPUT_BYTES = 4 * 1024 * 1024;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

const linuxSockets = new LinuxSockets();

export type ProcessEntry = {
  pid: number;
  parent: number;
  name: string;
  startedAt: number | null;
  directory: string | null;
  sessionVariable?: string | null;
};

export type ScanResult = {
  sockets: ListeningSocket[];
  processes: Map<number, ProcessEntry>;
};

export class RunningAppsError extends Error {
  constructor(
    readonly code: 'unavailable' | 'busy',
    message: string,
  ) {
    super(message);
    this.name = 'RunningAppsError';
  }
}

const forwardedVariables = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
];

function scanEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LC_ALL: 'C', LANG: 'C' };
  for (const name of forwardedVariables)
    if (process.env[name]) environment[name] = process.env[name];
  return environment;
}

async function runScan(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  acceptedCodes: readonly number[] = [0],
  stdin?: string,
): Promise<string> {
  const result = await runOwnedProcess({
    command,
    args,
    cwd: tmpdir(),
    env: scanEnvironment(),
    timeoutMs: SCAN_TIMEOUT_MS,
    maxOutputBytes: MAX_SCAN_OUTPUT_BYTES,
    stdin,
    signal,
  }).catch(() => {
    throw new RunningAppsError(
      'unavailable',
      'Running apps could not be read on this computer.',
    );
  });
  if (
    result.timedOut ||
    result.outputTruncated ||
    result.code === null ||
    !acceptedCodes.includes(result.code)
  )
    throw new RunningAppsError(
      'unavailable',
      'Running apps could not be read on this computer.',
    );
  return result.stdout;
}

const windowsProcessesSchema = z.array(
  z.object({
    pid: z.number().int(),
    parent: z.number().int(),
    name: z.string(),
    startedAt: z.number().nullable(),
  }),
);

async function scanWindows(signal: AbortSignal): Promise<ScanResult> {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const sockets = parseNetstat(
    await runScan(join(system, 'netstat.exe'), ['-ano'], signal),
  );
  if (sockets.length === 0) return { sockets, processes: new Map() };
  const listeners = [...new Set(sockets.map(socket => socket.pid))];
  const [snapshot, tasks] = await Promise.all([
    runScan(
      join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(WINDOWS_PROCESS_SNAPSHOT, 'utf16le').toString('base64'),
      ],
      signal,
      [0],
      listeners.join(',') + '\n',
    ),
    runScan(join(system, 'tasklist.exe'), ['/FO', 'CSV', '/NH'], signal).catch(
      () => '',
    ),
  ]);
  const names = parseTasklist(tasks);
  const entries = windowsProcessesSchema.parse(JSON.parse(snapshot));
  return {
    sockets,
    processes: new Map(
      entries.map(entry => [
        entry.pid,
        { ...entry, name: names.get(entry.pid) ?? entry.name, directory: null },
      ]),
    ),
  };
}
function readLinuxBootTime(): number | null {
  try {
    const match = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function readLinuxSessionVariable(pid: number): string | null {
  try {
    const prefix = `${PROVIDER_SESSION_VARIABLE}=`;
    const value = readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .find(item => item.startsWith(prefix));
    return value ? value.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

function readLinuxProcess(
  pid: number,
  bootTime: number | null,
  listening: boolean,
): ProcessEntry | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const nameEnd = stat.lastIndexOf(')');
    const name = stat.slice(stat.indexOf('(') + 1, nameEnd);
    const fields = stat.slice(nameEnd + 2).split(' ');
    const parent = Number(fields[1]);
    const ticks = Number(fields[19]);
    let directory: string | null = null;
    if (listening) {
      try {
        directory = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        directory = null;
      }
    }
    const sessionVariable = listening ? readLinuxSessionVariable(pid) : null;
    return {
      pid,
      parent: Number.isInteger(parent) ? parent : 0,
      name,
      startedAt:
        bootTime !== null && Number.isFinite(ticks)
          ? (bootTime + ticks / LINUX_CLOCK_TICKS_PER_SECOND) * 1000
          : null,
      directory,
      sessionVariable,
    };
  } catch {
    return null;
  }
}

async function scanLinux(signal: AbortSignal): Promise<ScanResult> {
  const sockets = await linuxSockets.read(signal);
  const bootTime = readLinuxBootTime();
  const processes = new Map<number, ProcessEntry>();
  const listeners = new Set(
    sockets.map(socket => socket.pid).filter(pid => pid > 0),
  );
  for (const pid of listeners) {
    let current = pid;
    for (
      let depth = 0;
      depth < 32 && current > 0 && !processes.has(current);
      depth++
    ) {
      const entry = readLinuxProcess(current, bootTime, listeners.has(current));
      if (!entry) break;
      processes.set(current, entry);
      current = entry.parent;
    }
  }
  return { sockets, processes };
}

export function parseLsofFields(output: string): {
  pid: number;
  name: string;
  values: string[];
  family?: string;
}[] {
  const groups: {
    pid: number;
    name: string;
    values: string[];
    family?: string;
  }[] = [];
  for (const line of output.split('\n')) {
    const field = line.slice(0, 1);
    const value = line.slice(1).trim();
    if (field === 'p')
      groups.push({ pid: Number(value), name: '', values: [] });
    const current = groups.at(-1);
    if (!current) continue;
    if (field === 'c') current.name = value;
    if (field === 't') current.family = value;
    if (field === 'n') {
      const address = current.family === 'IPv6' ? '[::]' : '0.0.0.0';
      current.values.push(value.replace(/^\*(?=:)/, address));
    }
  }
  return groups.filter(group => Number.isInteger(group.pid) && group.pid > 0);
}

const macSessionVariable = new RegExp(
  `(?:^|\\s)${PROVIDER_SESSION_VARIABLE}=([0-9a-f-]{36})(?=\\s|$)`,
  'i',
);

async function scanMac(signal: AbortSignal): Promise<ScanResult> {
  const listening = parseLsofFields(
    await runScan(
      '/usr/sbin/lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pctn'],
      signal,
      [0, 1],
    ),
  );
  const sockets = listening.flatMap(group =>
    group.values.flatMap(value => {
      const local = parseSocketAddress(value);
      return local && loopbackHost(local.address)
        ? [{ ...local, pid: group.pid }]
        : [];
    }),
  );
  if (sockets.length === 0) return { sockets, processes: new Map() };
  const processes = new Map<number, ProcessEntry>();
  for (const line of (
    await runScan('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], signal)
  ).split('\n')) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/.exec(
        line,
      );
    if (!match) continue;
    const start = Date.parse(match[3] ?? '');
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      parent: Number(match[2]),
      name: (match[4] ?? '').split('/').at(-1) ?? '',
      startedAt: Number.isFinite(start) ? start : null,
      directory: null,
    });
  }
  const listeningPids = [...new Set(sockets.map(socket => socket.pid))];
  if (listeningPids.length > 0) {
    const directories = await runScan(
      '/usr/sbin/lsof',
      ['-a', '-d', 'cwd', '-F', 'pn', '-p', listeningPids.join(',')],
      signal,
      [0, 1],
    ).catch(() => '');
    for (const group of parseLsofFields(directories)) {
      const entry = processes.get(group.pid);
      if (entry && group.values[0]) entry.directory = group.values[0];
    }
    const environments = await runScan(
      '/bin/ps',
      ['-wwE', '-o', 'pid=,command=', '-p', listeningPids.join(',')],
      signal,
      [0, 1],
    ).catch(() => '');
    for (const line of environments.split('\n')) {
      const pid = /^\s*(\d+)\s/.exec(line)?.[1];
      const value = macSessionVariable.exec(line)?.[1];
      const entry = pid ? processes.get(Number(pid)) : undefined;
      if (entry && value) entry.sessionVariable = value;
    }
  }
  return { sockets, processes };
}

export function scanRunningApps(signal: AbortSignal): Promise<ScanResult> {
  if (process.platform === 'win32') return scanWindows(signal);
  if (process.platform === 'darwin') return scanMac(signal);
  if (process.platform === 'linux') return scanLinux(signal);
  return Promise.reject(
    new RunningAppsError(
      'unavailable',
      'Running apps are not supported on this computer.',
    ),
  );
}
