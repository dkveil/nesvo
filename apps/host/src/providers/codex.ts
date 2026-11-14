import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, normalize } from 'node:path';
import {
  activityLimits,
  modelEffortsSchema,
  skillLimits,
  type CodexStatus,
  type ModelEfforts,
  type SkillDiscovery,
  type SkillReference,
  type ProviderUsage,
  type TurnUsage,
} from '@nesvo/contracts';
import { makeActivity, type ProviderActivity } from './activity';
import { readCodexUsage } from './codex-usage';
import {
  descendantScanMs,
  recordDescendants,
  signalRecorded,
} from './process-tree';
import {
  codexTokenSnapshot,
  codexTurnUsage,
  type CodexTokenSnapshot,
} from './turn-usage';

export type CodexEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'tool-activity'; activity: ProviderActivity }
  | {
      type: 'approval';
      approval: {
        id: string;
        kind: 'command' | 'file-change';
        title: string;
        detail: string;
        directory: string | null;
      };
    }
  | { type: 'approval-resolved'; id: string };

export type CodexResult = {
  status: 'completed' | 'stopped' | 'failed' | 'interrupted';
  error: string | null;
  interruption?: 'provider-disconnected';
  usage?: TurnUsage;
  structured?: unknown;
};

type Executable = { command: string; prefix: string[] };
type RecordValue = Record<string, unknown>;
type ProcessExit = {
  code: number | null;
  error: Error | null;
  confirmed: boolean;
};
type OwnedProcess = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<ProcessExit>;
  stop: () => Promise<void>;
  recordDescendants: () => void;
};

const maxLineBytes = 1024 * 1024;
const maxOutputBytes = 16 * 1024 * 1024;
const maxTextBytes = 2_000_000;
const probeTimeoutMs = 10_000;
const runTimeoutMs = 10 * 60_000;
const cleanupTimeoutMs = 4_000;
const isolatedFeatures = [
  'hooks',
  'plugins',
  'apps',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'workspace_dependencies',
  'skill_mcp_dependency_install',
  'auth_elicitation',
];
const isolatedConfig = {
  mcp_servers: {},
  web_search: 'disabled',
  ...Object.fromEntries(
    isolatedFeatures.map(feature => [`features.${feature}`, false]),
  ),
};

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function safeMessage(value: string): string {
  return value
    .replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .slice(0, 800);
}

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

function ownProcess(
  executable: Executable,
  args: string[],
  cwd?: string,
  environment?: Readonly<Record<string, string>>,
): OwnedProcess {
  const child = spawn(executable.command, [...executable.prefix, ...args], {
    cwd,
    env: {
      ...process.env,
      ...environment,
      ...(executable.prefix.length > 0 ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let processError: Error | null = null;
  let cleanup: Promise<void> | null = null;
  let hasClosed = false;
  let hasExited = false;
  let closeResolve: (value: ProcessExit) => void;
  const closed = new Promise<ProcessExit>(resolve => {
    closeResolve = resolve;
  });
  child.once('error', error => {
    processError = error;
  });
  child.stdin.on('error', error => {
    if (!hasClosed && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
      processError = error;
      void stop();
    }
  });
  child.stdout.on('error', error => {
    processError = error;
    void stop();
  });
  child.stderr.on('error', error => {
    processError = error;
    void stop();
  });
  const descendants = new Map<number, number>();
  const recordOwnedDescendants = () => {
    if (child.pid && !hasExited) recordDescendants(child.pid, descendants);
  };
  const descendantScan =
    process.platform === 'linux' && child.pid
      ? setInterval(recordOwnedDescendants, descendantScanMs).unref()
      : null;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !hasClosed) {
        child.kill(signal);
      }
    }
    signalRecorded(descendants, signal);
  };
  function stop(): Promise<void> {
    cleanup ??= (async () => {
      if (child.pid) {
        if (process.platform === 'win32') {
          if (
            !hasExited &&
            !hasClosed &&
            child.exitCode === null &&
            child.signalCode === null
          )
            await taskkill(child.pid);
        } else {
          recordOwnedDescendants();
          signalGroup('SIGTERM');
          await Promise.race([closed, wait(300)]);
          signalGroup('SIGKILL');
        }
      }
      await Promise.race([closed, wait(cleanupTimeoutMs)]);
      if (!hasClosed) {
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await Promise.race([closed, wait(300)]);
        if (!hasClosed)
          closeResolve({
            code: null,
            error: new Error('Codex process did not close after cleanup.'),
            confirmed: false,
          });
      }
    })();
    return cleanup;
  }
  child.once('exit', () => {
    hasExited = true;
    if (descendantScan) clearInterval(descendantScan);
    void stop();
  });
  child.once('close', code => {
    hasClosed = true;
    if (descendantScan) clearInterval(descendantScan);
    closeResolve({ code, error: processError, confirmed: true });
  });
  return {
    child,
    closed,
    stop,
    recordDescendants: recordOwnedDescendants,
  };
}

async function executablePath(): Promise<Executable | null> {
  const override = process.env.NESVO_CODEX_EXECUTABLE;
  if (override && !isAbsolute(override))
    throw new Error(
      'NESVO_CODEX_EXECUTABLE must be an absolute executable path.',
    );
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const local = process.env.LOCALAPPDATA;
  const desktopBins: string[] = [];
  if (!override && process.platform === 'win32' && local) {
    const root = join(local, 'OpenAI', 'Codex', 'bin');
    try {
      const versions = await readdir(root, { withFileTypes: true });
      desktopBins.push(
        ...versions
          .filter(entry => entry.isDirectory())
          .map(entry => join(root, entry.name, name)),
      );
    } catch {
      desktopBins.length = 0;
    }
  }
  const candidates = override
    ? [override]
    : [
        ...(process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map(directory => join(directory.replace(/^"|"$/g, ''), name)),
        join(homedir(), '.local', 'bin', name),
        join(
          homedir(),
          '.codex',
          'packages',
          'standalone',
          'current',
          'bin',
          name,
        ),
        ...(process.platform === 'win32' && local
          ? [
              join(local, 'Programs', 'OpenAI', 'Codex', 'bin', name),
              ...desktopBins,
            ]
          : []),
        ...(process.platform === 'darwin'
          ? [
              '/Applications/Codex.app/Contents/Resources/codex',
              join(
                homedir(),
                'Applications',
                'Codex.app',
                'Contents',
                'Resources',
                'codex',
              ),
              '/opt/homebrew/bin/codex',
              '/usr/local/bin/codex',
            ]
          : []),
        ...(process.platform === 'linux'
          ? [
              '/usr/local/bin/codex',
              '/usr/bin/codex',
              '/opt/Codex/resources/codex',
            ]
          : []),
      ];
  for (const candidate of new Set(candidates)) {
    try {
      await access(
        candidate,
        process.platform === 'win32' || /\.(?:mjs|cjs|js)$/i.test(candidate)
          ? constants.F_OK
          : constants.X_OK,
      );
      const resolved = await realpath(candidate);
      if (/\.(?:mjs|cjs|js)$/i.test(resolved))
        return { command: process.execPath, prefix: [resolved] };
      if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(resolved))
        continue;
      return { command: resolved, prefix: [] };
    } catch {
      continue;
    }
  }
  return null;
}

type RpcId = string | number;
type RpcPeer = {
  owned: OwnedProcess;
  request: (method: string, params: RecordValue) => Promise<RecordValue>;
  send: (value: RecordValue) => void;
  failure: Promise<Error>;
  close: () => Promise<ProcessExit>;
  closeIdle: () => Promise<ProcessExit>;
};

class CodexRpcError extends Error {
  readonly code: number | null;

  constructor(message: string, code: unknown) {
    super(message);
    this.code = typeof code === 'number' ? code : null;
  }
}

class CodexDisconnectedError extends Error {}

function rpcPeer(
  executable: Executable,
  cwd: string | undefined,
  onMessage: (message: RecordValue) => void,
  disabledServers: string[] = [],
  environment?: Readonly<Record<string, string>>,
): RpcPeer {
  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'mcp_servers={}',
    '-c',
    'web_search="disabled"',
    '-c',
    'notify=[]',
    '-c',
    'allow_login_shell=false',
    ...disabledServers.flatMap(name => [
      '-c',
      `mcp_servers.${name}.enabled=false`,
    ]),
    ...isolatedFeatures.flatMap(feature => ['--disable', feature]),
  ];
  const owned = ownProcess(executable, args, cwd, environment);
  const pending = new Map<
    RpcId,
    {
      resolve: (value: RecordValue) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let line = '';
  let bytes = 0;
  let closed = false;
  let failureError: Error | null = null;
  let resolveFailure: (error: Error) => void;
  const failure = new Promise<Error>(resolve => {
    resolveFailure = resolve;
  });
  const fail = (message: string, disconnected = false) => {
    if (failureError || closed) return;
    failureError = disconnected
      ? new CodexDisconnectedError(safeMessage(message))
      : new Error(safeMessage(message));
    resolveFailure(failureError);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failureError);
    }
    pending.clear();
    void owned.stop();
  };
  const send = (message: RecordValue) => {
    if (closed || failureError)
      throw failureError ?? new Error('Codex connection is closed.');
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > maxLineBytes)
      throw new Error('Codex request exceeded the supported size.');
    owned.child.stdin.write(`${serialized}\n`, error => {
      if (error)
        fail(
          'Codex request delivery failed.',
          ['EPIPE', 'ECONNRESET'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          ),
        );
    });
  };
  const consume = (serialized: string) => {
    if (!serialized.trim() || closed || failureError) return;
    try {
      const message = object(JSON.parse(serialized) as unknown);
      if (!message)
        throw new Error('Codex returned an invalid protocol message.');
      if (typeof message.method === 'string') {
        onMessage(message);
        return;
      }
      const id = message.id;
      if (
        (typeof id !== 'string' && typeof id !== 'number') ||
        !pending.has(id)
      )
        throw new Error('Codex returned an unknown response ID.');
      const entry = pending.get(id)!;
      pending.delete(id);
      clearTimeout(entry.timer);
      const error = object(message.error);
      if (error)
        entry.reject(
          new CodexRpcError(
            typeof error.message === 'string'
              ? safeMessage(error.message)
              : 'Codex request failed.',
            error.code,
          ),
        );
      else {
        const result = object(message.result);
        if (!result)
          entry.reject(new Error('Codex returned an invalid result.'));
        else entry.resolve(result);
      }
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : 'Codex returned malformed JSON.',
      );
    }
  };
  owned.child.stdout.setEncoding('utf8');
  owned.child.stdout.on('data', (chunk: string) => {
    if (closed || failureError) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxOutputBytes)
      return fail('Codex streaming output exceeded the supported size.');
    line += chunk;
    let newline: number;
    while ((newline = line.indexOf('\n')) !== -1) {
      const next = line.slice(0, newline);
      line = line.slice(newline + 1);
      if (Buffer.byteLength(next) > maxLineBytes)
        return fail('Codex streaming message exceeded the supported size.');
      consume(next);
    }
    if (Buffer.byteLength(line) > maxLineBytes)
      fail('Codex streaming message exceeded the supported size.');
  });
  owned.child.stderr.resume();
  void owned.closed.then(exit => {
    if (line) consume(line);
    if (!closed)
      fail(
        exit.error
          ? 'Codex app-server failed to start or communicate.'
          : `Codex app-server closed before the operation completed (exit ${exit.code}).`,
        Boolean(owned.child.pid),
      );
  });
  const close = async (idle: boolean): Promise<ProcessExit> => {
    const graceful = idle && !closed && !failureError && pending.size === 0;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Codex connection closed.'));
    }
    pending.clear();
    owned.recordDescendants();
    if (graceful && !owned.child.stdin.destroyed) {
      try {
        owned.child.stdin.end();
        await Promise.race([owned.closed, wait(300)]);
      } catch {}
    }
    await owned.stop();
    return owned.closed;
  };
  return {
    owned,
    send,
    failure,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (closed || failureError)
          return reject(
            failureError ?? new Error('Codex connection is closed.'),
          );
        const id = ++nextId;
        const timer = setTimeout(
          () => fail(`Codex ${method} request timed out.`),
          probeTimeoutMs,
        );
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, method, params });
        } catch (error) {
          fail(
            error instanceof Error ? error.message : 'Codex request failed.',
          );
        }
      }),
    close: () => close(false),
    closeIdle: () => close(true),
  };
}

function rejectRequest(peer: RpcPeer, message: RecordValue): void {
  if (typeof message.id === 'string' || typeof message.id === 'number') {
    peer.send({
      id: message.id,
      error: { code: -32601, message: 'Unsupported server request.' },
    });
    throw new Error(
      `Unsupported Codex server request: ${String(message.method)}.`,
    );
  }
}

async function initialize(
  peer: RpcPeer,
  experimentalApi = false,
): Promise<string> {
  const result = await peer.request('initialize', {
    clientInfo: { name: 'nesvo', title: 'Nesvo', version: '0.1.0' },
    capabilities: { experimentalApi, requestAttestation: false },
  });
  const version =
    typeof result.userAgent === 'string'
      ? /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(result.userAgent)?.[0]
      : null;
  if (!version)
    throw new Error(
      'Codex did not report a supported app-server version. Update Codex.',
    );
  peer.send({ method: 'initialized' });
  return version;
}

const codexEffortSupport = { status: 'per-model' } as const;

function modelEfforts(model: RecordValue): ModelEfforts | null {
  const supported = model.supportedReasoningEfforts;
  if (supported == null || (Array.isArray(supported) && !supported.length))
    return null;
  if (!Array.isArray(supported))
    throw new Error('Codex returned invalid reasoning effort metadata.');
  const parsed = modelEffortsSchema.safeParse({
    options: supported.map(value => {
      const option = object(value);
      return {
        id: option?.reasoningEffort,
        description:
          typeof option?.description === 'string'
            ? option.description.slice(0, 500)
            : '',
      };
    }),
    defaultEffort: model.defaultReasoningEffort,
  });
  if (!parsed.success)
    throw new Error('Codex returned invalid reasoning effort metadata.');
  return parsed.data;
}

async function readAccountAndModels(
  peer: RpcPeer,
): Promise<Pick<CodexStatus, 'status' | 'detail' | 'models' | 'effort'>> {
  const auth = await peer.request('account/read', { refreshToken: false });
  const account = object(auth.account);
  if (auth.account === null)
    return {
      status: 'unauthenticated',
      detail: 'Sign in with codex login, then refresh Codex status.',
      models: [],
      effort: codexEffortSupport,
    };
  if (
    !account ||
    !['chatgpt', 'apiKey', 'amazonBedrock'].includes(String(account.type))
  )
    throw new Error('Codex authentication could not be verified.');
  const models = new Map<string, CodexStatus['models'][number]>([
    ['default', { id: 'default', label: 'Codex default', efforts: null }],
  ]);
  let cursor: string | null = null;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = await peer.request('model/list', {
      limit: 100,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result.data))
      throw new Error('Codex returned an invalid model catalog.');
    for (const value of result.data) {
      const model = object(value);
      if (
        !model ||
        typeof model.model !== 'string' ||
        !model.model ||
        model.model.length > 200 ||
        typeof model.displayName !== 'string'
      )
        throw new Error('Codex returned an invalid model entry.');
      if (model.hidden !== true)
        models.set(model.model, {
          id: model.model,
          label: model.displayName.slice(0, 200),
          efforts: modelEfforts(model),
        });
    }
    if (result.nextCursor === null)
      return {
        status: 'ready',
        detail: null,
        models: [...models.values()],
        effort: codexEffortSupport,
      };
    if (
      typeof result.nextCursor !== 'string' ||
      !result.nextCursor ||
      cursors.has(result.nextCursor)
    )
      throw new Error('Codex returned an invalid model catalog cursor.');
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error('Codex model catalog exceeded the supported size.');
}

export async function inspectCodex(signal?: AbortSignal): Promise<CodexStatus> {
  let peer: RpcPeer | null = null;
  let version: string | null = null;
  const cancel = () => {
    void peer?.close();
  };
  try {
    if (signal?.aborted) throw new Error('Stopped.');
    const executable = await executablePath();
    if (!executable)
      return {
        status: 'missing',
        version: null,
        detail:
          'Install the native Codex CLI, then sign in with codex login. Restart Nesvo if PATH changed.',
        models: [],
        effort: codexEffortSupport,
      };
    if (signal?.aborted) throw new Error('Stopped.');
    peer = rpcPeer(executable, undefined, message =>
      rejectRequest(peer!, message),
    );
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) throw new Error('Stopped.');
    version = await initialize(peer);
    const status = await readAccountAndModels(peer);
    return { ...status, version };
  } catch (error) {
    return {
      status: 'error',
      version,
      detail: safeMessage(
        error instanceof Error ? error.message : 'Codex inspection failed.',
      ),
      models: [],
      effort: codexEffortSupport,
    };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await peer?.closeIdle();
  }
}

export async function inspectCodexUsage(
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const scoped = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(20_000),
  ]);
  let peer: RpcPeer | null = null;
  let result: ProviderUsage = {
    provider: 'Codex',
    status: 'error',
    account: null,
    windows: [],
    checkedAt: new Date().toISOString(),
    source: 'codex-app-server',
    ordinaryUsageAllowed: null,
    detail: 'Codex usage could not be checked. Refresh to try again.',
  };
  const cancel = () => {
    void peer?.close();
  };
  try {
    scoped.throwIfAborted();
    const executable = await executablePath();
    if (!executable)
      return {
        ...result,
        status: 'unavailable',
        detail: 'Install Codex on this computer to read its account limits.',
      };
    scoped.throwIfAborted();
    peer = rpcPeer(executable, undefined, message =>
      rejectRequest(peer!, message),
    );
    scoped.addEventListener('abort', cancel, { once: true });
    scoped.throwIfAborted();
    await initialize(peer);
    const auth = await peer.request('account/read', { refreshToken: false });
    if (auth.account === null) {
      result.status = 'unauthenticated';
      result.detail = 'Sign in with codex login on this computer.';
    } else {
      const account = object(auth.account);
      if (!account) throw new Error('Invalid account.');
      if (account.type === 'chatgpt') {
        result.account = {
          label: typeof account.email === 'string' ? account.email : null,
          plan: typeof account.planType === 'string' ? account.planType : null,
        };
        result = readCodexUsage(
          await peer.request('account/rateLimits/read', {}),
          result.account,
        );
      } else if (['apiKey', 'amazonBedrock'].includes(String(account.type))) {
        result.status = 'unavailable';
        result.account = {
          label: account.type === 'apiKey' ? 'API key' : 'Amazon Bedrock',
          plan: null,
        };
        result.detail =
          'Subscription usage windows are not available for this authentication method.';
      } else throw new Error('Unsupported account.');
    }
    scoped.throwIfAborted();
  } catch (error) {
    result = {
      ...result,
      status:
        error instanceof CodexRpcError && error.code === -32601
          ? 'unavailable'
          : 'error',
      windows: [],
      ordinaryUsageAllowed: null,
      detail:
        error instanceof CodexRpcError && error.code === -32601
          ? 'This Codex version does not expose account limits. Update Codex.'
          : 'Codex usage could not be checked. Refresh to try again.',
    };
  } finally {
    scoped.removeEventListener('abort', cancel);
    const closed = await peer?.closeIdle();
    if (closed && !closed.confirmed) {
      result.status = 'error';
      result.windows = [];
      result.detail = 'The Codex account inspection could not close cleanly.';
    }
  }
  return { ...result, checkedAt: new Date().toISOString() };
}

class CodexSkillProtocolError extends Error {}

function comparablePath(path: string): string {
  return process.platform === 'win32'
    ? normalize(path).toLowerCase()
    : normalize(path);
}

export function codexSkillId(name: string, path: string): string {
  return `codex:${createHash('sha256').update(path).update('\0').update(name).digest('hex')}`;
}

async function registerCodexSkillRoots(
  peer: RpcPeer,
  extraRoots: string[],
  checkCancelled: () => void,
): Promise<void> {
  checkCancelled();
  if (!Array.isArray(extraRoots) || extraRoots.length > skillLimits.entries)
    throw new Error(
      `Shared skills require at most ${skillLimits.entries} directories.`,
    );
  const roots = new Map<string, string>();
  for (const root of extraRoots) {
    checkCancelled();
    if (
      typeof root !== 'string' ||
      !root ||
      root.length > skillLimits.path ||
      !isAbsolute(root)
    )
      throw new Error(
        'Shared skill directories must be absolute paths within the supported path size.',
      );
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch {
      throw new Error(
        'A shared skill directory is missing or inaccessible. Refresh the skill library.',
      );
    }
    checkCancelled();
    const directory = await stat(canonical);
    checkCancelled();
    if (
      !directory.isDirectory() ||
      comparablePath(canonical) !== comparablePath(root) ||
      canonical.length > skillLimits.path
    )
      throw new Error(
        'A shared skill directory changed or is not canonical. Refresh the skill library.',
      );
    roots.set(comparablePath(canonical), canonical);
  }
  if (roots.size === 0) return;
  const params = { extraRoots: [...roots.values()] };
  if (
    Buffer.byteLength(
      JSON.stringify({
        id: Number.MAX_SAFE_INTEGER,
        method: 'skills/extraRoots/set',
        params,
      }),
    ) > maxLineBytes
  )
    throw new Error(
      'Shared skill directories exceeded the supported request size.',
    );
  checkCancelled();
  await peer.request('skills/extraRoots/set', params);
  checkCancelled();
}

async function verifyCodexSkillIsolation(
  peer: RpcPeer,
  cwd: string,
): Promise<void> {
  const isolated = await peer.request('config/read', {
    includeLayers: false,
    cwd,
  });
  const effective = object(isolated.config);
  const effectiveMcp = object(effective?.mcp_servers);
  const features = object(effective?.features);
  if (
    !effective ||
    (effective.mcp_servers != null && !effectiveMcp) ||
    Object.values(effectiveMcp ?? {}).some(
      value => object(value)?.enabled !== false,
    ) ||
    !features ||
    isolatedFeatures.some(
      name =>
        features[name] !== undefined &&
        features[name] !== false &&
        features[name] !== null,
    )
  )
    throw new Error(
      'Codex could not isolate inherited tools and hooks for skill discovery.',
    );
}

function codexSkillListing(
  result: RecordValue,
  cwd: string,
): { skills: unknown[]; errors: unknown[] } {
  const entry =
    Array.isArray(result.data) && result.data.length === 1
      ? object(result.data[0])
      : null;
  if (
    !entry ||
    typeof entry.cwd !== 'string' ||
    comparablePath(entry.cwd) !== comparablePath(cwd) ||
    !Array.isArray(entry.skills) ||
    !Array.isArray(entry.errors)
  )
    throw new CodexSkillProtocolError(
      'Codex returned an unsupported skill listing for the requested directory.',
    );
  return { skills: entry.skills, errors: entry.errors };
}

function codexSkillMetadata(value: unknown): {
  reference: SkillReference;
  scope: string;
  description: string;
  enabled: boolean;
  pluginId: string | null;
} | null {
  const skill = object(value);
  if (
    !skill ||
    typeof skill.name !== 'string' ||
    !skill.name.trim() ||
    skill.name.length > skillLimits.name ||
    typeof skill.description !== 'string' ||
    typeof skill.path !== 'string' ||
    !skill.path ||
    skill.path.length > skillLimits.path ||
    !isAbsolute(skill.path) ||
    typeof skill.enabled !== 'boolean' ||
    !['user', 'repo', 'system', 'admin'].includes(String(skill.scope)) ||
    (skill.pluginId != null && typeof skill.pluginId !== 'string')
  )
    return null;
  const presentation = object(skill.interface);
  const description =
    typeof presentation?.shortDescription === 'string'
      ? presentation.shortDescription
      : typeof skill.shortDescription === 'string'
        ? skill.shortDescription
        : skill.description;
  const source =
    skill.scope === 'repo'
      ? 'project'
      : skill.scope === 'admin'
        ? 'managed'
        : skill.scope === 'system'
          ? 'system'
          : 'user';
  return {
    reference: {
      id: codexSkillId(skill.name, skill.path),
      name: skill.name,
      path: skill.path,
      source,
    },
    scope: String(skill.scope),
    description,
    enabled: skill.enabled,
    pluginId: typeof skill.pluginId === 'string' ? skill.pluginId : null,
  };
}

async function resolveCodexSkill(
  peer: RpcPeer,
  directory: string,
  skillId: string,
): Promise<SkillReference> {
  const cwd = await realpath(directory);
  if (
    comparablePath(cwd) !== comparablePath(directory) ||
    !(await stat(cwd)).isDirectory()
  )
    throw new Error(
      'The session directory changed. Refresh skills before sending this message.',
    );
  let result: RecordValue;
  try {
    result = await peer.request('skills/list', {
      cwds: [cwd],
      forceReload: true,
    });
  } catch (error) {
    if (error instanceof CodexRpcError && error.code === -32601)
      throw new Error(
        'This Codex CLI cannot verify the selected skill. Update Codex or send without a skill.',
      );
    throw error;
  }
  const listing = codexSkillListing(result, cwd);
  const matches = listing.skills.filter(value => {
    const skill = object(value);
    return (
      typeof skill?.name === 'string' &&
      typeof skill.path === 'string' &&
      codexSkillId(skill.name, skill.path) === skillId
    );
  });
  if (matches.length !== 1)
    throw new Error(
      'The selected skill is missing or ambiguous in the current Codex catalog. Refresh skills and select it again.',
    );
  const skill = codexSkillMetadata(matches[0]);
  if (!skill || !skill.enabled || skill.pluginId !== null)
    throw new Error(
      'The selected skill is disabled or unavailable in this session profile. Refresh skills or send without a skill.',
    );
  return skill.reference;
}

export async function inspectCodexSkills(
  directory: string,
  signal?: AbortSignal,
  extraRoots: string[] = [],
): Promise<SkillDiscovery & { extraRootsSupported: boolean }> {
  const discovery: SkillDiscovery & { extraRootsSupported: boolean } = {
    provider: 'Codex',
    method: 'native',
    status: 'unavailable',
    skills: [],
    issues: [],
    truncated: false,
    invocationSupported: false,
    extraRootsSupported: false,
    checkedAt: new Date().toISOString(),
  };
  let peer: RpcPeer | null = null;
  let timedOut = false;
  const cancel = () => {
    void peer?.close();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, probeTimeoutMs * 3);
  const checkCancelled = () => {
    if (timedOut) throw new Error('Codex skill discovery timed out.');
    if (signal?.aborted) throw new Error('Codex skill discovery stopped.');
  };
  const issue = (path: string | null, message: string) => {
    if (discovery.issues.length >= skillLimits.issues) {
      discovery.truncated = true;
      return;
    }
    discovery.issues.push({
      path: path && path.length <= skillLimits.path ? path : null,
      message: safeMessage(message).slice(0, skillLimits.detail),
    });
  };
  try {
    signal?.addEventListener('abort', cancel, { once: true });
    checkCancelled();
    if (!isAbsolute(directory) || directory.length > skillLimits.path)
      throw new Error(
        'Codex skill discovery requires an absolute working directory within the supported path size.',
      );
    const cwd = await realpath(directory);
    if (!(await stat(cwd)).isDirectory())
      throw new Error('Codex skill discovery requires a working directory.');
    checkCancelled();
    const executable = await executablePath();
    if (!executable)
      throw new Error('Install the native Codex CLI to discover its skills.');
    checkCancelled();
    peer = rpcPeer(executable, cwd, message => rejectRequest(peer!, message));
    await initialize(peer);
    const loaded = await peer.request('config/read', {
      includeLayers: false,
      cwd,
    });
    const config = object(loaded.config);
    const mcp = object(config?.mcp_servers);
    if (!config || (config.mcp_servers != null && !mcp))
      throw new Error('Codex tool configuration could not be verified.');
    const disabledServers = Object.keys(mcp ?? {});
    if (disabledServers.some(name => !/^[\w-]+$/.test(name)))
      throw new Error(
        'Codex has an MCP server name that cannot be safely isolated.',
      );
    const bootstrapExit = await peer.closeIdle();
    if (!bootstrapExit.confirmed)
      throw new Error(
        'Codex inspection process closure could not be confirmed.',
      );
    checkCancelled();
    peer = rpcPeer(
      executable,
      cwd,
      message => rejectRequest(peer!, message),
      disabledServers,
    );
    await initialize(peer);
    await verifyCodexSkillIsolation(peer, cwd);
    checkCancelled();
    if (!Array.isArray(extraRoots) || extraRoots.length > 0) {
      try {
        await registerCodexSkillRoots(peer, extraRoots, checkCancelled);
        discovery.extraRootsSupported = true;
      } catch (error) {
        checkCancelled();
        if (!(error instanceof CodexRpcError) || error.code !== -32601)
          throw error;
        issue(
          null,
          `Shared skill directories could not be registered; only the native catalog is available. ${error instanceof Error ? error.message : 'Registration failed.'}`,
        );
      }
    }
    checkCancelled();
    const result = await peer.request('skills/list', {
      cwds: [cwd],
      forceReload: true,
    });
    checkCancelled();
    const entry = codexSkillListing(result, cwd);
    const ids = new Set<string>();
    let suppressedPlugins = 0;
    let invalidSkills = 0;
    let shortenedDescriptions = 0;
    for (const value of entry.skills) {
      const raw = object(value);
      const skill = codexSkillMetadata(value);
      const path =
        typeof raw?.path === 'string' && raw.path.length <= skillLimits.path
          ? raw.path
          : null;
      if (!skill) {
        invalidSkills++;
        issue(
          path,
          'Codex returned invalid skill metadata; this entry was omitted.',
        );
        continue;
      }
      if (skill.pluginId != null) {
        suppressedPlugins++;
        continue;
      }
      if (discovery.skills.length >= skillLimits.entries) {
        discovery.truncated = true;
        continue;
      }
      const { id } = skill.reference;
      if (ids.has(id)) {
        invalidSkills++;
        issue(
          path,
          'Codex returned duplicate skill metadata; the duplicate was omitted.',
        );
        continue;
      }
      ids.add(id);
      const { description } = skill;
      if (description.length > skillLimits.description) {
        shortenedDescriptions++;
        discovery.truncated = true;
      }
      discovery.skills.push({
        ...skill.reference,
        description: description.slice(0, skillLimits.description),
        kind: 'skill',
        enabled: skill.enabled,
        userInvocable: null,
        modelInvocable: null,
        detail: `Native Codex ${String(skill.scope)} skill metadata.`,
      });
    }
    for (const value of entry.errors) {
      const error = object(value);
      issue(
        typeof error?.path === 'string' ? error.path : null,
        typeof error?.message === 'string'
          ? error.message
          : 'Codex reported an invalid skill discovery issue.',
      );
    }
    if (suppressedPlugins)
      issue(
        null,
        `${suppressedPlugins} plugin skill entries were omitted because plugins are disabled in the session profile.`,
      );
    if (shortenedDescriptions)
      issue(
        null,
        `${shortenedDescriptions} skill descriptions exceeded the supported display size and were shortened.`,
      );
    if (
      entry.skills.length >
      discovery.skills.length + suppressedPlugins + invalidSkills
    )
      issue(
        null,
        `The skill catalog exceeded the limit of ${skillLimits.entries} entries.`,
      );
    discovery.status =
      discovery.issues.length ||
      discovery.truncated ||
      suppressedPlugins ||
      invalidSkills
        ? 'partial'
        : 'ready';
    discovery.invocationSupported = true;
  } catch (error) {
    discovery.extraRootsSupported = false;
    discovery.status =
      error instanceof CodexSkillProtocolError ||
      (error instanceof CodexRpcError && error.code === -32601)
        ? 'unsupported'
        : 'unavailable';
    discovery.skills = [];
    issue(
      null,
      timedOut
        ? 'Codex skill discovery timed out.'
        : signal?.aborted
          ? 'Codex skill discovery stopped.'
          : error instanceof Error
            ? error.message
            : 'Codex skill discovery failed.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    const exit = await peer?.closeIdle();
    if (exit && !exit.confirmed) {
      discovery.status = 'unavailable';
      discovery.extraRootsSupported = false;
      discovery.invocationSupported = false;
      discovery.skills = [];
      issue(
        null,
        'Codex process closure could not be confirmed after skill discovery.',
      );
    }
    discovery.checkedAt = new Date().toISOString();
  }
  return discovery;
}

const constrainedMessage = (messages: ReadonlyMap<string, string>): unknown => {
  const last = [...messages.values()].at(-1);
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return undefined;
  }
};

export function startCodex(options: {
  directory: string;
  sessionId: string | null;
  resume: boolean;
  model: string;
  effort?: string | null;
  mode: 'read-only' | 'supervised';
  turnSandbox?: 'read-only';
  prompt: string;
  environment?: Readonly<Record<string, string>>;
  skillId?: string;
  skillRoots?: string[];
  onSkillResolved?: (skill: SkillReference) => void | Promise<void>;
  onEvent: (event: CodexEvent) => void;
  onDelegate?: (input: unknown, signal: AbortSignal) => Promise<string>;
  delegationSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  instructionsOnly?: boolean;
}): {
  done: Promise<CodexResult>;
  stop: () => Promise<void>;
  respondApproval: (requestId: string, decision: 'accept' | 'decline') => void;
} {
  let stopped = false;
  let finished = false;
  let peer: RpcPeer | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let startingTurn = false;
  let failure: string | null = null;
  let stopTask: Promise<void> | null = null;
  const approvals = new Map<
    string,
    { rpcId: RpcId; threadId: string; turnId: string }
  >();
  const seenRequests = new Set<string>();
  const seenCalls = new Set<string>();
  const pendingDelegates = new Map<
    string,
    { rpcId: RpcId; threadId: string; turnId: string }
  >();
  const delegationController = new AbortController();
  const queued: RecordValue[] = [];
  const messages = new Map<string, string>();
  const items = new Map<string, RecordValue>();
  const toolActivities = new Map<string, ProviderActivity>();
  const toolOutput = new Map<string, string>();
  const ignoredItems = new Set<string>();
  let lastText = '';
  let firstTokens: CodexTokenSnapshot | null = null;
  let latestTokens: CodexTokenSnapshot | null = null;
  let resolveTurn: (result: CodexResult) => void;
  const turnDone = new Promise<CodexResult>(resolve => {
    resolveTurn = resolve;
  });
  const outcome: { confirmed?: CodexResult } = {};
  const confirmTurn = (result: CodexResult) => {
    if (outcome.confirmed) return;
    outcome.confirmed = result;
    resolveTurn(result);
  };
  const fail = (message: string) => {
    failure ??= safeMessage(message);
    delegationController.abort();
    pendingDelegates.clear();
    resolveTurn({ status: 'failed', error: failure });
    void peer?.close();
  };
  const emit = (event: CodexEvent) => {
    if (stopped || finished || failure) return;
    try {
      options.onEvent(event);
    } catch {
      fail('Codex event delivery failed.');
    }
  };
  const resolveApproval = (id: string) => {
    if (!approvals.delete(id)) return;
    try {
      options.onEvent({ type: 'approval-resolved', id });
    } catch {
      fail('Codex approval delivery failed.');
    }
  };
  const publish = () => {
    const text = [...messages.values()].join('\n\n');
    if (Buffer.byteLength(text) > maxTextBytes)
      return fail('Codex response exceeded the supported size.');
    if (text !== lastText) {
      lastText = text;
      emit({ type: 'text', text });
    }
  };
  const emitTool = (activity: ProviderActivity) => {
    const previous = toolActivities.get(activity.id);
    if (
      previous &&
      previous.status !== 'running' &&
      activity.status === 'running'
    )
      return;
    const next = makeActivity({
      ...activity,
      startedAt: previous?.startedAt ?? activity.startedAt,
      completedAt: previous?.completedAt ?? activity.completedAt,
      truncated: previous?.truncated === true || activity.truncated,
    });
    toolActivities.set(next.id, next);
    emit({ type: 'tool-activity', activity: next });
  };
  const recordTool = (item: RecordValue, completed: boolean) => {
    const id = String(item.id);
    const previous = toolActivities.get(id);
    const changes = Array.isArray(item.changes) ? item.changes.map(object) : [];
    const actions = Array.isArray(item.commandActions)
      ? item.commandActions.map(object)
      : [];
    let kind: ProviderActivity['kind'];
    let title: string;
    let detail: string | null = null;
    let paths: string[] = [];
    if (item.type === 'commandExecution') {
      kind =
        actions.length > 0 && actions.every(action => action?.type === 'read')
          ? 'read'
          : 'command';
      title = kind === 'read' ? 'Read file' : 'Run command';
      detail = typeof item.command === 'string' ? item.command : null;
      paths = actions.flatMap(action =>
        typeof action?.path === 'string' ? [action.path] : [],
      );
    } else if (item.type === 'fileChange') {
      kind = 'file-change';
      title = 'Change files';
      paths = changes.flatMap(change => {
        const changeKind = object(change?.kind);
        return [change?.path, changeKind?.move_path].filter(
          (value): value is string => typeof value === 'string',
        );
      });
      detail = paths.join('\n') || null;
    } else if (item.type === 'webSearch') {
      kind = 'search';
      title = 'Search web';
      const action = object(item.action);
      detail =
        typeof item.query === 'string'
          ? item.query
          : typeof action?.query === 'string'
            ? action.query
            : null;
    } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      kind = 'tool';
      title = 'Use tool';
      detail =
        [item.server, item.tool]
          .filter(value => typeof value === 'string')
          .join(' / ') || null;
    } else return;
    const status =
      item.status === 'failed' ||
      (typeof item.exitCode === 'number' && item.exitCode !== 0)
        ? 'failed'
        : item.status === 'declined'
          ? 'declined'
          : completed
            ? item.status === 'completed' || item.type === 'webSearch'
              ? 'completed'
              : 'interrupted'
            : 'running';
    const error = object(item.error);
    const errorDetail = [
      typeof item.exitCode === 'number' && item.exitCode !== 0
        ? `Exit code: ${item.exitCode}`
        : '',
      typeof error?.code === 'string' || typeof error?.code === 'number'
        ? `Error code: ${error.code}`
        : '',
      typeof error?.message === 'string' ? error.message : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (errorDetail) detail = [detail, errorDetail].filter(Boolean).join('\n');
    const output =
      item.type === 'commandExecution' &&
      typeof item.aggregatedOutput === 'string'
        ? item.aggregatedOutput
        : (toolOutput.get(id) ?? previous?.output ?? '');
    emitTool(
      makeActivity({
        id,
        kind,
        title,
        status,
        detail,
        paths,
        output,
        startedAt: previous?.startedAt,
      }),
    );
  };
  const approvalId = (id: RpcId) => `codex-${typeof id}-${id}`;
  const consume = (message: RecordValue) => {
    if (!peer) return;
    if (finished || stopped || failure) return;
    if (startingTurn) {
      if (queued.length >= 1000)
        throw new Error('Codex sent too many events before starting the turn.');
      queued.push(message);
      return;
    }
    const params = object(message.params);
    const rpcId = message.id;
    if (rpcId !== undefined) {
      if (
        typeof rpcId !== 'string' &&
        (typeof rpcId !== 'number' || !Number.isSafeInteger(rpcId))
      )
        throw new Error('Codex returned an invalid server request ID.');
      const id = approvalId(rpcId);
      if (id.length > 200 || seenRequests.has(id) || seenRequests.size >= 1000)
        throw new Error(
          'Codex returned an invalid or repeated server request ID.',
        );
      seenRequests.add(id);
      if (message.method === 'item/tool/call') {
        if (
          !options.onDelegate ||
          !threadId ||
          !turnId ||
          params?.threadId !== threadId ||
          params.turnId !== turnId ||
          params.namespace !== null ||
          params.tool !== 'nesvo_delegate' ||
          typeof params.callId !== 'string' ||
          !params.callId ||
          params.callId.length > 200 ||
          seenCalls.has(params.callId) ||
          seenCalls.size >= 1000
        ) {
          peer.send({
            id: rpcId,
            result: {
              contentItems: [
                {
                  type: 'inputText',
                  text: 'Unsupported or stale delegation request.',
                },
              ],
              success: false,
            },
          });
          throw new Error(
            'Codex returned an unsupported, duplicate or stale delegation request.',
          );
        }
        const callId = params.callId;
        seenCalls.add(callId);
        const pending = { rpcId, threadId, turnId };
        pendingDelegates.set(callId, pending);
        emitTool(
          makeActivity({
            id,
            kind: 'tool',
            title: 'Delegate workers',
            status: 'running',
            detail: 'Waiting for operator decisions and worker results.',
          }),
        );
        const respond = (text: string, success: boolean) => {
          if (
            stopped ||
            finished ||
            failure ||
            delegationController.signal.aborted ||
            !peer ||
            pendingDelegates.get(callId) !== pending ||
            pending.threadId !== threadId ||
            pending.turnId !== turnId
          )
            return;
          if (
            typeof text !== 'string' ||
            Buffer.byteLength(text) > maxTextBytes ||
            Buffer.byteLength(
              JSON.stringify({
                id: rpcId,
                result: {
                  contentItems: [{ type: 'inputText', text }],
                  success,
                },
              }),
            ) > maxLineBytes
          ) {
            text = 'Worker results exceeded the supported response size.';
            success = false;
          }
          pendingDelegates.delete(callId);
          emitTool(
            makeActivity({
              id,
              kind: 'tool',
              title: 'Delegate workers',
              status: success ? 'completed' : 'failed',
              startedAt: toolActivities.get(id)?.startedAt,
            }),
          );
          try {
            peer.send({
              id: rpcId,
              result: { contentItems: [{ type: 'inputText', text }], success },
            });
          } catch (error) {
            fail(
              error instanceof Error
                ? error.message
                : 'Codex delegation response failed.',
            );
          }
        };
        void Promise.resolve()
          .then(() => {
            if (delegationController.signal.aborted)
              throw new Error('Delegation stopped.');
            return options.onDelegate!(
              params.arguments,
              delegationController.signal,
            );
          })
          .then(
            text => respond(text, true),
            error =>
              respond(
                safeMessage(
                  error instanceof Error ? error.message : 'Delegation failed.',
                ),
                false,
              ),
          );
        return;
      }
      const command =
        message.method === 'item/commandExecution/requestApproval';
      const file = message.method === 'item/fileChange/requestApproval';
      if (!command && !file) return rejectRequest(peer, message);
      if (
        options.mode !== 'supervised' ||
        !threadId ||
        !turnId ||
        params?.threadId !== threadId ||
        params.turnId !== turnId ||
        typeof params.itemId !== 'string' ||
        !params.itemId ||
        (command &&
          params.environmentId != null &&
          params.environmentId !== 'local') ||
        (command && params.networkApprovalContext != null) ||
        (command && params.kind !== undefined && params.kind !== 'command') ||
        (file && params.grantRoot != null)
      ) {
        peer.send({ id: rpcId, result: { decision: 'decline' } });
        throw new Error(
          'Codex requested unsupported permissions or an approval outside the active thread and turn.',
        );
      }
      const item = items.get(params.itemId);
      const reviewableChanges =
        item?.type === 'fileChange' &&
        Array.isArray(item.changes) &&
        item.changes.length > 0 &&
        item.changes.every(value => {
          const change = object(value);
          return (
            typeof change?.path === 'string' &&
            change.path.trim().length > 0 &&
            typeof change.diff === 'string' &&
            change.diff.trim().length > 0 &&
            object(change.kind) !== null
          );
        });
      const changes =
        reviewableChanges && Array.isArray(item?.changes)
          ? item.changes
              .map(object)
              .map(
                change =>
                  `${JSON.stringify(change?.kind)} ${String(change?.path)}\n${String(change?.diff)}`,
              )
              .join('\n')
          : '';
      const detail = [
        command && typeof params.command === 'string'
          ? params.command
          : changes,
        typeof params.reason === 'string' ? params.reason : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const directory =
        typeof params.cwd === 'string' ? params.cwd : options.directory;
      if (
        (command &&
          (typeof params.command !== 'string' || !params.command.trim())) ||
        (file && !reviewableChanges) ||
        detail.length > 100_000 ||
        directory.length > 4096 ||
        !isAbsolute(directory) ||
        (params.cwd != null && typeof params.cwd !== 'string')
      ) {
        peer.send({ id: rpcId, result: { decision: 'decline' } });
        throw new Error(
          'Codex returned an approval without complete reviewable details within the supported size.',
        );
      }
      approvals.set(id, { rpcId, threadId, turnId });
      emit({
        type: 'approval',
        approval: {
          id,
          kind: command ? 'command' : 'file-change',
          title: command ? 'Run command' : 'Change files',
          detail,
          directory,
        },
      });
      return;
    }
    if (!params || params.threadId !== threadId || !turnId) return;
    if (message.method === 'serverRequest/resolved') {
      if (
        [...pendingDelegates.values()].some(
          pending => pending.rpcId === params.requestId,
        )
      ) {
        fail(
          'Codex cancelled a delegation request before receiving worker outcomes.',
        );
        return;
      }
      if (
        typeof params.requestId === 'string' ||
        typeof params.requestId === 'number'
      )
        resolveApproval(approvalId(params.requestId));
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = object(params.turn);
      if (turn?.id !== turnId) return;
      if (turn.status === 'completed' && pendingDelegates.size > 0)
        throw new Error(
          'Codex completed the turn before receiving worker outcomes.',
        );
      delegationController.abort();
      pendingDelegates.clear();
      for (const id of approvals.keys()) resolveApproval(id);
      const usage = codexTurnUsage(firstTokens, latestTokens, turn);
      if (turn.status === 'completed')
        confirmTurn(
          lastText
            ? {
                status: 'completed',
                error: null,
                usage,
                ...(options.outputSchema
                  ? { structured: constrainedMessage(messages) }
                  : {}),
              }
            : {
                status: 'failed',
                error: 'Codex completed without an assistant response.',
                usage,
              },
        );
      else if (turn.status === 'interrupted')
        confirmTurn(
          stopped
            ? { status: 'stopped', error: null, usage }
            : {
                status: 'interrupted',
                interruption: 'provider-disconnected',
                error:
                  'Codex interrupted the turn before confirming its outcome. Inspect the workspace before continuing.',
                usage,
              },
        );
      else {
        const error = object(turn.error);
        confirmTurn({
          usage,
          status: 'failed',
          error: safeMessage(
            typeof error?.message === 'string'
              ? error.message
              : 'Codex did not complete the turn.',
          ),
        });
      }
      return;
    }
    if (params.turnId !== turnId) return;
    if (message.method === 'thread/tokenUsage/updated') {
      const snapshot = codexTokenSnapshot(params);
      if (snapshot) {
        firstTokens ??= snapshot;
        latestTokens = snapshot;
      }
      return;
    }
    if (
      message.method === 'item/started' ||
      message.method === 'item/completed'
    ) {
      const item = object(params.item);
      if (!item || typeof item.id !== 'string' || typeof item.type !== 'string')
        throw new Error('Codex returned an invalid turn item.');
      if (items.size >= 2000 && !items.has(item.id))
        throw new Error('Codex turn exceeded the supported item count.');
      items.set(item.id, item);
      recordTool(item, message.method === 'item/completed');
      if (item.type === 'agentMessage') {
        if (item.delivery === 'async') {
          ignoredItems.add(item.id);
          messages.delete(item.id);
        } else if (!ignoredItems.has(item.id)) {
          if (typeof item.text !== 'string')
            throw new Error('Codex returned invalid assistant text.');
          messages.set(item.id, item.text);
        }
        publish();
      } else if (
        message.method === 'item/started' &&
        ['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall'].includes(
          item.type,
        )
      ) {
        emit({
          type: 'activity',
          text:
            item.type === 'commandExecution'
              ? 'Running command'
              : item.type === 'fileChange'
                ? 'Editing files'
                : item.type === 'webSearch'
                  ? 'Searching the web'
                  : 'Using tool',
        });
      }
    } else if (message.method === 'item/commandExecution/outputDelta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string')
        throw new Error('Codex returned invalid command output.');
      const activity = toolActivities.get(params.itemId);
      if (!activity) return;
      let output = (toolOutput.get(params.itemId) ?? '') + params.delta;
      let truncated = activity.truncated;
      if (output.length > activityLimits.output * 2) {
        const newline = output.indexOf(
          '\n',
          output.length - activityLimits.output * 2,
        );
        output =
          newline === -1
            ? '[Output omitted: a line exceeded the supported size.]\n'
            : output.slice(newline + 1);
        truncated = true;
      }
      toolOutput.set(params.itemId, output);
      emitTool(makeActivity({ ...activity, output, truncated }));
    } else if (message.method === 'item/agentMessage/delta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string')
        throw new Error('Codex returned invalid text streaming data.');
      if (
        !ignoredItems.has(params.itemId) &&
        items.get(params.itemId)?.type === 'agentMessage'
      ) {
        messages.set(
          params.itemId,
          (messages.get(params.itemId) ?? '') + params.delta,
        );
        publish();
      }
    } else if (message.method === 'error' && params.willRetry !== true) {
      const error = object(params.error);
      fail(
        typeof error?.message === 'string'
          ? error.message
          : 'Codex could not continue. Check account limits and authentication.',
      );
    }
  };
  const done = (async (): Promise<CodexResult> => {
    const timer = setTimeout(
      () => fail('Codex turn timed out after ten minutes.'),
      runTimeoutMs,
    );
    let result: CodexResult;
    try {
      if (!isAbsolute(options.directory))
        throw new Error('Codex working directory must be an absolute path.');
      if (
        options.skillId !== undefined &&
        (typeof options.skillId !== 'string' ||
          !options.skillId ||
          options.skillId.length > 8192)
      )
        throw new Error(
          'The selected skill identifier is invalid. Refresh skills and select it again.',
        );
      if (!['read-only', 'supervised'].includes(options.mode))
        throw new Error('Unsupported Codex permission mode.');
      if (options.onDelegate && !object(options.delegationSchema))
        throw new Error('Codex delegation requires an explicit input schema.');
      if (
        options.resume &&
        (!options.sessionId || options.sessionId.length > 200)
      )
        throw new Error('Codex resume requires a valid provider thread ID.');
      const executable = await executablePath();
      if (stopped) return { status: 'stopped', error: null };
      if (!executable)
        throw new Error(
          'Install the native Codex CLI and sign in with codex login.',
        );
      peer = rpcPeer(
        executable,
        options.directory,
        consume,
        [],
        options.environment,
      );
      await initialize(peer);
      const status = await readAccountAndModels(peer);
      if (status.status !== 'ready')
        throw new Error(status.detail ?? 'Codex is unavailable.');
      if (!status.models.some(model => model.id === options.model))
        throw new Error(
          'Unsupported Codex model. Refresh the available model list.',
        );
      const loaded = await peer.request('config/read', {
        includeLayers: false,
        cwd: options.directory,
      });
      const config = object(loaded.config);
      if (!config)
        throw new Error('Codex tool configuration could not be verified.');
      const mcp = object(config.mcp_servers);
      if (config.mcp_servers != null && !mcp)
        throw new Error('Codex MCP configuration could not be verified.');
      const disabledServers = Object.fromEntries(
        Object.keys(mcp ?? {}).map(name => [name, { enabled: false }]),
      );
      if (Object.keys(disabledServers).some(name => !/^[\w-]+$/.test(name)))
        throw new Error(
          'Codex has an MCP server name that cannot be safely isolated.',
        );
      const bootstrapExit = await peer.closeIdle();
      if (!bootstrapExit.confirmed)
        throw new Error(
          'Codex inspection process closure could not be confirmed.',
        );
      if (stopped || failure) throw new Error(failure ?? 'Stopped.');
      peer = rpcPeer(
        executable,
        options.directory,
        consume,
        Object.keys(disabledServers),
        options.environment,
      );
      await initialize(peer, Boolean(options.onDelegate));
      const isolated = await peer.request('config/read', {
        includeLayers: false,
        cwd: options.directory,
      });
      const effective = object(isolated.config);
      const effectiveMcp = object(effective?.mcp_servers);
      if (
        !effective ||
        (effective.mcp_servers != null && !effectiveMcp) ||
        Object.values(effectiveMcp ?? {}).some(
          value => object(value)?.enabled !== false,
        )
      )
        throw new Error('Codex could not disable inherited MCP servers.');
      const features = object(effective.features);
      if (
        !features ||
        isolatedFeatures.some(
          name =>
            features[name] !== undefined &&
            features[name] !== false &&
            features[name] !== null,
        )
      )
        throw new Error('Codex could not isolate inherited tools and hooks.');
      if (
        options.skillRoots !== undefined &&
        (!Array.isArray(options.skillRoots) || options.skillRoots.length > 0)
      )
        await registerCodexSkillRoots(peer, options.skillRoots, () => {
          if (stopped || failure) throw new Error(failure ?? 'Stopped.');
        });
      if (stopped || failure) throw new Error(failure ?? 'Stopped.');
      const skill =
        options.skillId === undefined
          ? null
          : await resolveCodexSkill(peer, options.directory, options.skillId);
      if (stopped || failure) throw new Error(failure ?? 'Stopped.');
      if (skill) {
        try {
          await options.onSkillResolved?.(skill);
        } catch {
          throw new Error(
            'The selected skill could not be verified or saved. No provider turn was started.',
          );
        }
      }
      if (stopped || failure) throw new Error(failure ?? 'Stopped.');
      const approvalPolicy =
        options.mode === 'read-only' ? 'never' : 'untrusted';
      const sandboxPolicy =
        options.mode === 'read-only'
          ? { type: 'readOnly', networkAccess: false }
          : {
              type: 'workspaceWrite',
              writableRoots: [options.directory],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            };
      const readOnlyTurn = options.turnSandbox === 'read-only';
      const turnApprovalPolicy = readOnlyTurn ? 'never' : approvalPolicy;
      const turnSandboxPolicy = readOnlyTurn
        ? { type: 'readOnly', networkAccess: false }
        : sandboxPolicy;
      const model = options.model === 'default' ? {} : { model: options.model };
      const effort = options.effort ? { effort: options.effort } : {};
      const response = await peer.request(
        options.resume ? 'thread/resume' : 'thread/start',
        {
          ...(options.resume
            ? { threadId: options.sessionId, excludeTurns: true }
            : {}),
          ...model,
          ...(!options.resume && options.onDelegate
            ? {
                dynamicTools: [
                  {
                    type: 'function',
                    name: 'nesvo_delegate',
                    description: `When the task benefits from delegation, propose one or two visible workers with separate tasks and explicit scopes. Each worker starts only after operator approval. Use existing directories within this workspace ("." is allowed). Choose an available Codex model ID or a Claude alias (default, opus, sonnet, haiku). The tool waits for every operator decision and actual worker outcome. Workers cannot delegate. ${options.mode === 'supervised' ? 'This session has write access, so every proposed worker must use read-only mode. Use a separate read-only session when workers need to change files.' : 'This session is read-only. Workers may use supervised mode to change files in non-overlapping directories.'}`,
                    inputSchema: options.delegationSchema,
                    deferLoading: false,
                  },
                ],
              }
            : {}),
          cwd: options.directory,
          approvalPolicy,
          approvalsReviewer: 'user',
          sandbox:
            options.mode === 'read-only' ? 'read-only' : 'workspace-write',
          config: {
            ...isolatedConfig,
            ...(options.effort
              ? { model_reasoning_effort: options.effort }
              : {}),
            ...(options.instructionsOnly ? { project_doc_max_bytes: 0 } : {}),
            mcp_servers: disabledServers,
            notify: [],
            allow_login_shell: false,
            sandbox_workspace_write: {
              writable_roots: [options.directory],
              network_access: false,
              exclude_tmpdir_env_var: true,
              exclude_slash_tmp: true,
            },
          },
        },
      );
      const thread = object(response.thread);
      const sandbox = object(response.sandbox);
      if (
        typeof thread?.id !== 'string' ||
        !thread.id ||
        thread.id.length > 200 ||
        typeof response.model !== 'string' ||
        (options.resume && thread.id !== options.sessionId)
      )
        throw new Error('Codex returned an invalid or mismatched thread.');
      if (
        response.approvalPolicy !== approvalPolicy ||
        sandbox?.type !== sandboxPolicy.type ||
        sandbox.networkAccess !== false ||
        (response.approvalsReviewer !== undefined &&
          response.approvalsReviewer !== 'user')
      )
        throw new Error('Codex did not apply the requested permission policy.');
      if (options.effort && response.reasoningEffort !== options.effort)
        throw new Error(
          'Codex did not apply the requested reasoning effort. No provider turn was started.',
        );
      threadId = thread.id;
      emit({ type: 'init', sessionId: threadId, model: response.model });
      if (stopped || failure) throw new Error(failure ?? 'Stopped.');
      startingTurn = true;
      const started = await peer.request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: options.prompt, text_elements: [] },
          ...(skill
            ? [{ type: 'skill', name: skill.name, path: skill.path }]
            : []),
        ],
        cwd: options.directory,
        approvalPolicy: turnApprovalPolicy,
        approvalsReviewer: 'user',
        sandboxPolicy: turnSandboxPolicy,
        ...model,
        ...effort,
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      const turn = object(started.turn);
      if (typeof turn?.id !== 'string' || !turn.id || turn.id.length > 200)
        throw new Error('Codex returned an invalid turn.');
      turnId = turn.id;
      startingTurn = false;
      for (const message of queued.splice(0)) consume(message);
      result = await Promise.race([
        turnDone,
        peer.failure.then(error =>
          error instanceof CodexDisconnectedError
            ? {
                status: 'interrupted' as const,
                interruption: 'provider-disconnected' as const,
                error: error.message,
              }
            : { status: 'failed' as const, error: error.message },
        ),
      ]);
    } catch (error) {
      result = failure
        ? { status: 'failed', error: failure }
        : stopped
          ? { status: 'stopped', error: null }
          : error instanceof CodexDisconnectedError
            ? {
                status: 'interrupted',
                interruption: 'provider-disconnected',
                error: error.message,
              }
            : {
                status: 'failed',
                error: safeMessage(
                  error instanceof Error ? error.message : 'Codex failed.',
                ),
              };
    } finally {
      clearTimeout(timer);
      finished = true;
      delegationController.abort();
      pendingDelegates.clear();
      for (const id of approvals.keys()) resolveApproval(id);
      const exit = await peer?.close();
      if (exit && !exit.confirmed)
        failure = 'Codex process closure could not be confirmed after cleanup.';
    }
    return failure
      ? { status: 'failed', error: failure }
      : outcome.confirmed?.status === 'completed' ||
          outcome.confirmed?.status === 'failed'
        ? outcome.confirmed
        : stopped
          ? { status: 'stopped', error: null }
          : result;
  })();
  return {
    done,
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        delegationController.abort();
        pendingDelegates.clear();
        resolveTurn({ status: 'stopped', error: null });
        for (const id of approvals.keys()) resolveApproval(id);
        if (peer && threadId && turnId)
          await Promise.race([
            peer
              .request('turn/interrupt', { threadId, turnId })
              .catch(() => undefined),
            wait(300),
          ]);
        await peer?.close();
        await done;
      })();
      return stopTask;
    },
    respondApproval: (requestId, decision) => {
      const pending = approvals.get(requestId);
      if (decision !== 'accept' && decision !== 'decline')
        throw new Error('Unsupported Codex approval decision.');
      if (
        stopped ||
        finished ||
        failure ||
        !peer ||
        !pending ||
        pending.threadId !== threadId ||
        pending.turnId !== turnId
      )
        throw new Error('Codex approval is no longer pending for this turn.');
      try {
        peer.send({ id: pending.rpcId, result: { decision } });
        resolveApproval(requestId);
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : 'Codex approval response failed.',
        );
        throw error;
      }
    },
  };
}
