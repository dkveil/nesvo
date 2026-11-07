import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export type CodexStatus = {
  status: 'ready' | 'missing' | 'unauthenticated' | 'unsupported' | 'error';
  version: string | null;
  detail: string | null;
  models: { id: string; label: string }[];
};

export type CodexEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; text: string }
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
  status: 'completed' | 'stopped' | 'failed';
  error: string | null;
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
): OwnedProcess {
  const child = spawn(executable.command, [...executable.prefix, ...args], {
    cwd,
    env:
      executable.prefix.length > 0
        ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        : process.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let processError: Error | null = null;
  let cleanup: Promise<void> | null = null;
  let hasClosed = false;
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
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !hasClosed) {
        child.kill(signal);
      }
    }
  };
  function stop(): Promise<void> {
    cleanup ??= (async () => {
      if (child.pid) {
        if (process.platform === 'win32') {
          await taskkill(child.pid);
        } else {
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
    void stop();
  });
  child.once('close', code => {
    hasClosed = true;
    closeResolve({ code, error: processError, confirmed: true });
  });
  return { child, closed, stop };
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
  failure: Promise<string>;
  close: () => Promise<ProcessExit>;
};

function rpcPeer(
  executable: Executable,
  cwd: string | undefined,
  onMessage: (message: RecordValue) => void,
  disabledServers: string[] = [],
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
  const owned = ownProcess(executable, args, cwd);
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
  let failureMessage: string | null = null;
  let resolveFailure: (message: string) => void;
  const failure = new Promise<string>(resolve => {
    resolveFailure = resolve;
  });
  const fail = (message: string) => {
    if (failureMessage || closed) return;
    failureMessage = safeMessage(message);
    resolveFailure(failureMessage);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(failureMessage));
    }
    pending.clear();
    void owned.stop();
  };
  const send = (message: RecordValue) => {
    if (closed || failureMessage)
      throw new Error(failureMessage ?? 'Codex connection is closed.');
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > maxLineBytes)
      throw new Error('Codex request exceeded the supported size.');
    owned.child.stdin.write(`${serialized}\n`, error => {
      if (error) fail('Codex request delivery failed.');
    });
  };
  const consume = (serialized: string) => {
    if (!serialized.trim() || closed || failureMessage) return;
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
          new Error(
            typeof error.message === 'string'
              ? safeMessage(error.message)
              : 'Codex request failed.',
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
    if (closed || failureMessage) return;
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
      );
  });
  return {
    owned,
    send,
    failure,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (closed || failureMessage)
          return reject(
            new Error(failureMessage ?? 'Codex connection is closed.'),
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
    close: async () => {
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Codex connection closed.'));
      }
      pending.clear();
      await owned.stop();
      return owned.closed;
    },
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

async function initialize(peer: RpcPeer): Promise<string> {
  const result = await peer.request('initialize', {
    clientInfo: { name: 'nesvo', title: 'Nesvo', version: '0.1.0' },
    capabilities: { experimentalApi: false, requestAttestation: false },
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

async function readAccountAndModels(
  peer: RpcPeer,
): Promise<Pick<CodexStatus, 'status' | 'detail' | 'models'>> {
  const auth = await peer.request('account/read', { refreshToken: false });
  const account = object(auth.account);
  if (auth.account === null)
    return {
      status: 'unauthenticated',
      detail: 'Sign in with codex login, then refresh Codex status.',
      models: [],
    };
  if (
    !account ||
    !['chatgpt', 'apiKey', 'amazonBedrock'].includes(String(account.type))
  )
    throw new Error('Codex authentication could not be verified.');
  const models = new Map<string, { id: string; label: string }>([
    ['default', { id: 'default', label: 'Codex default' }],
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
        });
    }
    if (result.nextCursor === null)
      return { status: 'ready', detail: null, models: [...models.values()] };
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
    };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await peer?.close();
  }
}

export function startCodex(options: {
  directory: string;
  sessionId: string | null;
  resume: boolean;
  model: string;
  mode: 'read-only' | 'supervised';
  prompt: string;
  onEvent: (event: CodexEvent) => void;
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
  const queued: RecordValue[] = [];
  const messages = new Map<string, string>();
  const items = new Map<string, RecordValue>();
  const ignoredItems = new Set<string>();
  let lastText = '';
  let resolveTurn: (result: CodexResult) => void;
  const turnDone = new Promise<CodexResult>(resolve => {
    resolveTurn = resolve;
  });
  const fail = (message: string) => {
    failure ??= safeMessage(message);
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
        throw new Error('Codex returned an invalid approval request ID.');
      const id = approvalId(rpcId);
      if (id.length > 200 || seenRequests.has(id) || seenRequests.size >= 1000)
        throw new Error(
          'Codex returned an invalid or repeated approval request ID.',
        );
      seenRequests.add(id);
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
          title: command ? 'Wykonanie polecenia' : 'Zmiana plików',
          detail,
          directory,
        },
      });
      return;
    }
    if (!params || params.threadId !== threadId || !turnId) return;
    if (message.method === 'serverRequest/resolved') {
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
      for (const id of approvals.keys()) resolveApproval(id);
      if (turn.status === 'completed')
        resolveTurn(
          lastText
            ? { status: 'completed', error: null }
            : {
                status: 'failed',
                error: 'Codex completed without an assistant response.',
              },
        );
      else if (turn.status === 'interrupted')
        resolveTurn({ status: 'stopped', error: null });
      else {
        const error = object(turn.error);
        resolveTurn({
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
      if (!['read-only', 'supervised'].includes(options.mode))
        throw new Error('Unsupported Codex permission mode.');
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
      peer = rpcPeer(executable, options.directory, consume);
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
      const bootstrapExit = await peer.close();
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
      );
      await initialize(peer);
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
      const model = options.model === 'default' ? {} : { model: options.model };
      const response = await peer.request(
        options.resume ? 'thread/resume' : 'thread/start',
        {
          ...(options.resume
            ? { threadId: options.sessionId, excludeTurns: true }
            : {}),
          ...model,
          cwd: options.directory,
          approvalPolicy,
          approvalsReviewer: 'user',
          sandbox:
            options.mode === 'read-only' ? 'read-only' : 'workspace-write',
          config: {
            ...isolatedConfig,
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
      threadId = thread.id;
      emit({ type: 'init', sessionId: threadId, model: response.model });
      if (stopped || failure) throw new Error(failure ?? 'Stopped.');
      startingTurn = true;
      const started = await peer.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: options.prompt, text_elements: [] }],
        cwd: options.directory,
        approvalPolicy,
        approvalsReviewer: 'user',
        sandboxPolicy,
        ...model,
      });
      const turn = object(started.turn);
      if (typeof turn?.id !== 'string' || !turn.id || turn.id.length > 200)
        throw new Error('Codex returned an invalid turn.');
      turnId = turn.id;
      startingTurn = false;
      for (const message of queued.splice(0)) consume(message);
      result = await Promise.race([
        turnDone,
        peer.failure.then(error => ({ status: 'failed' as const, error })),
      ]);
    } catch (error) {
      result = failure
        ? { status: 'failed', error: failure }
        : stopped
          ? { status: 'stopped', error: null }
          : {
              status: 'failed',
              error: safeMessage(
                error instanceof Error ? error.message : 'Codex failed.',
              ),
            };
    } finally {
      clearTimeout(timer);
      finished = true;
      for (const id of approvals.keys()) resolveApproval(id);
      const exit = await peer?.close();
      if (exit && !exit.confirmed)
        failure = 'Codex process closure could not be confirmed after cleanup.';
    }
    return failure
      ? { status: 'failed', error: failure }
      : stopped
        ? { status: 'stopped', error: null }
        : result;
  })();
  return {
    done,
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
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
