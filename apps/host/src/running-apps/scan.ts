import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { runOwnedProcess } from '../process/owned-process';
import { PROVIDER_SESSION_VARIABLE } from '../process/provider-processes';

const SCAN_TIMEOUT_MS = 10_000;
const MAX_SCAN_OUTPUT_BYTES = 4 * 1024 * 1024;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export type ListeningSocket = { address: string; port: number; pid: number };

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
): Promise<string> {
  const result = await runOwnedProcess({
    command,
    args,
    cwd: tmpdir(),
    env: scanEnvironment(),
    timeoutMs: SCAN_TIMEOUT_MS,
    maxOutputBytes: MAX_SCAN_OUTPUT_BYTES,
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

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sockets = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })',
  '$processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = [string]$_.Name; startedAt = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } })',
  '[pscustomobject]@{ sockets = $sockets; processes = $processes } | ConvertTo-Json -Compress -Depth 3',
].join('; ');

const windowsScanSchema = z.object({
  sockets: z
    .array(
      z.object({
        address: z.string(),
        port: z.number().int(),
        pid: z.number().int(),
      }),
    )
    .nullable()
    .optional(),
  processes: z
    .array(
      z.object({
        pid: z.number().int(),
        parent: z.number().int(),
        name: z.string().nullable(),
        startedAt: z.number().nullable(),
      }),
    )
    .nullable()
    .optional(),
});

async function scanWindows(signal: AbortSignal): Promise<ScanResult> {
  const output = await runScan(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
    signal,
  );
  let parsed: z.infer<typeof windowsScanSchema>;
  try {
    parsed = windowsScanSchema.parse(JSON.parse(output));
  } catch {
    throw new RunningAppsError(
      'unavailable',
      'Running apps could not be read on this computer.',
    );
  }
  return {
    sockets: (parsed.sockets ?? []).filter(socket => socket.pid > 0),
    processes: new Map(
      (parsed.processes ?? []).map(entry => [
        entry.pid,
        {
          pid: entry.pid,
          parent: entry.parent,
          name: entry.name ?? '',
          startedAt: entry.startedAt,
          directory: null,
        },
      ]),
    ),
  };
}

export function parseSocketAddress(
  value: string,
): { address: string; port: number } | null {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const address = value
    .slice(0, separator)
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  return { address, port };
}

export function parseSsListening(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'LISTEN' || !columns[3]) continue;
    const local = parseSocketAddress(columns[3]);
    if (!local) continue;
    for (const match of line.matchAll(/pid=(\d+)/g))
      sockets.push({ ...local, pid: Number(match[1]) });
  }
  return sockets;
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
): ProcessEntry | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const nameEnd = stat.lastIndexOf(')');
    const name = stat.slice(stat.indexOf('(') + 1, nameEnd);
    const fields = stat.slice(nameEnd + 2).split(' ');
    const parent = Number(fields[1]);
    const ticks = Number(fields[19]);
    let directory: string | null = null;
    try {
      directory = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      directory = null;
    }
    const sessionVariable = readLinuxSessionVariable(pid);
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
  const sockets = parseSsListening(await runScan('ss', ['-ltnpH'], signal));
  const bootTime = readLinuxBootTime();
  const processes = new Map<number, ProcessEntry>();
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const found = readLinuxProcess(Number(entry), bootTime);
    if (found) processes.set(found.pid, found);
  }
  return { sockets, processes };
}

export function parseLsofFields(output: string): {
  pid: number;
  name: string;
  values: string[];
}[] {
  const groups: { pid: number; name: string; values: string[] }[] = [];
  for (const line of output.split('\n')) {
    const field = line.slice(0, 1);
    const value = line.slice(1).trim();
    if (field === 'p')
      groups.push({ pid: Number(value), name: '', values: [] });
    const current = groups.at(-1);
    if (!current) continue;
    if (field === 'c') current.name = value;
    if (field === 'n') current.values.push(value);
  }
  return groups.filter(group => Number.isInteger(group.pid) && group.pid > 0);
}

export function parseElapsed(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return (
    ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 +
    Number(seconds) * 1000
  );
}

const macSessionVariable = new RegExp(
  `(?:^|\\s)${PROVIDER_SESSION_VARIABLE}=([0-9a-f-]{36})(?=\\s|$)`,
  'i',
);

async function scanMac(signal: AbortSignal): Promise<ScanResult> {
  const listening = parseLsofFields(
    await runScan(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'],
      signal,
      [0, 1],
    ),
  );
  const sockets = listening.flatMap(group =>
    group.values.flatMap(value => {
      const local = parseSocketAddress(value);
      return local ? [{ ...local, pid: group.pid }] : [];
    }),
  );
  const now = Date.now();
  const processes = new Map<number, ProcessEntry>();
  for (const line of (
    await runScan('ps', ['-axo', 'pid=,ppid=,etime=,comm='], signal)
  ).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const elapsed = parseElapsed(match[3] ?? '');
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      parent: Number(match[2]),
      name: (match[4] ?? '').split('/').at(-1) ?? '',
      startedAt: elapsed === null ? null : now - elapsed,
      directory: null,
    });
  }
  const listeningPids = [...new Set(sockets.map(socket => socket.pid))];
  if (listeningPids.length > 0) {
    const directories = await runScan(
      'lsof',
      ['-a', '-d', 'cwd', '-F', 'pn', '-p', listeningPids.join(',')],
      signal,
      [0, 1],
    ).catch(() => '');
    for (const group of parseLsofFields(directories)) {
      const entry = processes.get(group.pid);
      if (entry && group.values[0]) entry.directory = group.values[0];
    }
    const environments = await runScan(
      'ps',
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
