import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { type ClaudeStatus, type ProviderUsage } from '@nesvo/contracts';
import { readFrames } from '../daemon-channel';
import { makeActivity, type ProviderActivity } from './activity';
import { claudeUsageResult } from './claude-usage';

export type ClaudeEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'tool-activity'; activity: ProviderActivity };

export type ClaudeResult = {
  status: 'completed' | 'stopped' | 'failed' | 'interrupted';
  error: string | null;
  interruption?: 'provider-disconnected';
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

const models = [
  { id: 'default', label: 'Claude Code default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
] satisfies ClaudeStatus['models'];
const requiredFlags = [
  '--print',
  '--output-format',
  '--input-format',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  '--permission-prompts',
  '--tools',
  '--allowedTools',
  '--strict-mcp-config',
  '--mcp-config',
  '--settings',
  '--session-id',
  '--resume',
  '--model',
];
const maxLineBytes = 1024 * 1024;
const maxOutputBytes = 16 * 1024 * 1024;
const maxTextBytes = 2_000_000;
const probeTimeoutMs = 5_000;
const runTimeoutMs = 10 * 60_000;
const cleanupTimeoutMs = 4_000;

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
          if (
            !hasExited &&
            !hasClosed &&
            child.exitCode === null &&
            child.signalCode === null
          )
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
        await Promise.race([closed, wait(300)]);
        if (!hasClosed)
          closeResolve({
            code: null,
            error: new Error('Claude process did not close after cleanup.'),
            confirmed: false,
          });
      }
    })();
    return cleanup;
  }
  child.once('exit', () => {
    hasExited = true;
    void stop();
  });
  child.once('close', code => {
    hasClosed = true;
    closeResolve({ code, error: processError, confirmed: true });
  });
  return { child, closed, stop };
}

async function executablePath(): Promise<Executable | null> {
  const override = process.env.NESVO_CLAUDE_EXECUTABLE;
  if (override && !isAbsolute(override)) {
    throw new Error(
      'NESVO_CLAUDE_EXECUTABLE must be an absolute executable path.',
    );
  }
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  const candidates = override
    ? [override]
    : [
        ...(process.env.PATH ?? '')
          .split(delimiter)
          .flatMap(directory =>
            directory
              ? names.map(name => join(directory.replace(/^"|"$/g, ''), name))
              : [],
          ),
        join(homedir(), '.local', 'bin', names[0]!),
        ...(process.platform === 'win32'
          ? []
          : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
      ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(
        candidate,
        process.platform === 'win32' || /\.(?:mjs|cjs|js)$/i.test(candidate)
          ? constants.F_OK
          : constants.X_OK,
      );
      const resolved = await realpath(candidate);
      if (/\.(?:mjs|cjs|js)$/i.test(resolved)) {
        return { command: process.execPath, prefix: [resolved] };
      }
      if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(resolved))
        continue;
      return { command: resolved, prefix: [] };
    } catch {
      continue;
    }
  }
  return null;
}

async function probe(
  executable: Executable,
  args: string[],
  cancelled: () => boolean,
) {
  if (cancelled()) throw new Error('Stopped.');
  const owned = ownProcess(executable, args);
  let stdout = '';
  let bytes = 0;
  let failure: string | null = null;
  const timer = setTimeout(() => {
    failure = 'Claude Code inspection timed out.';
    void owned.stop();
  }, probeTimeoutMs);
  const cancellation = setInterval(() => {
    if (cancelled()) void owned.stop();
  }, 50);
  owned.child.stdout.setEncoding('utf8');
  owned.child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxLineBytes) {
      failure = 'Claude Code inspection returned too much data.';
      void owned.stop();
    } else {
      stdout += chunk;
    }
  });
  owned.child.stderr.resume();
  owned.child.stdin.end();
  try {
    const result = await Promise.race([
      owned.closed,
      wait(probeTimeoutMs + cleanupTimeoutMs * 2).then(() => {
        throw new Error('Claude Code inspection did not close.');
      }),
    ]);
    if (failure) throw new Error(failure);
    if (result.error)
      throw new Error(
        'Claude Code could not be started. Check its installation.',
      );
    if (cancelled()) throw new Error('Stopped.');
    return { code: result.code, stdout };
  } finally {
    clearTimeout(timer);
    clearInterval(cancellation);
    await owned.stop();
  }
}

async function inspect(cancelled: () => boolean): Promise<{
  status: ClaudeStatus;
  executable: Executable | null;
}> {
  let version: string | null = null;
  const status = (
    state: ClaudeStatus['status'],
    detail: string | null,
  ): ClaudeStatus => ({
    status: state,
    version,
    detail,
    models: state === 'ready' ? models.map(model => ({ ...model })) : [],
    effort: {
      status: 'unsupported',
      reason:
        'Nesvo runs Claude Code without a reasoning effort setting, so the CLI default applies.',
    },
  });
  try {
    const executable = await executablePath();
    if (!executable) {
      return {
        executable: null,
        status: status(
          'missing',
          'Install the native Claude Code CLI, then sign in with claude auth login. Restart Nesvo if PATH changed.',
        ),
      };
    }
    const probes = await Promise.allSettled([
      probe(executable, ['--version'], cancelled),
      probe(executable, ['--help'], cancelled),
      probe(executable, ['auth', 'status', '--json'], cancelled),
    ]);
    const outputs = probes.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const [versionResult, help, auth] = outputs as [
      Awaited<ReturnType<typeof probe>>,
      Awaited<ReturnType<typeof probe>>,
      Awaited<ReturnType<typeof probe>>,
    ];
    if (versionResult.code !== 0) {
      return {
        executable,
        status: status('error', 'Claude Code version inspection failed.'),
      };
    }
    version =
      /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(versionResult.stdout)?.[0] ??
      null;
    const missing = requiredFlags.filter(flag => !help.stdout.includes(flag));
    if (help.code !== 0 || missing.length > 0 || !version) {
      return {
        executable,
        status: status(
          'unsupported',
          `Update Claude Code: required streaming and analysis capabilities are unavailable${missing.length ? ` (${missing.join(', ')})` : ''}.`,
        ),
      };
    }
    let authentication: RecordValue | null;
    try {
      authentication = object(JSON.parse(auth.stdout) as unknown);
    } catch {
      return {
        executable,
        status: status(
          'unsupported',
          'Claude Code did not return a supported authentication status. Update the CLI.',
        ),
      };
    }
    if (
      authentication?.loggedIn === false ||
      (auth.code === 1 && authentication)
    ) {
      return {
        executable,
        status: status(
          'unauthenticated',
          'Sign in with claude auth login, then refresh Claude Code status.',
        ),
      };
    }
    if (auth.code !== 0 || authentication?.loggedIn !== true) {
      return {
        executable,
        status: status(
          'error',
          'Claude Code authentication could not be verified.',
        ),
      };
    }
    return { executable, status: status('ready', null) };
  } catch (error) {
    return {
      executable: null,
      status: status(
        'error',
        safeMessage(
          error instanceof Error
            ? error.message
            : 'Claude Code inspection failed.',
        ),
      ),
    };
  }
}

export async function inspectClaude(
  signal?: AbortSignal,
): Promise<ClaudeStatus> {
  return (await inspect(() => signal?.aborted ?? false)).status;
}

export async function inspectClaudeUsage(
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  let owned: OwnedProcess | null = null;
  let result = claudeUsageResult(null, null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => void) | undefined;
  let abort: (() => void) | undefined;
  let failureReported = false;
  const failResult = (status: ProviderUsage['status'], detail: string) => {
    failureReported = true;
    result = {
      ...result,
      status,
      detail,
      windows: [],
      checkedAt: new Date().toISOString(),
    };
  };
  try {
    if (signal?.aborted) throw new Error('Stopped.');
    const executable = await executablePath();
    if (!executable) {
      failResult(
        'unavailable',
        'Install Claude Code to read its account limits.',
      );
      return result;
    }
    if (signal?.aborted) throw new Error('Stopped.');
    owned = ownProcess(executable, [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode',
      'plan',
      '--permission-prompts',
      'none',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
    const running = owned;
    let finished = false;
    let account: unknown;
    const initializeId = randomUUID();
    const usageId = randomUUID();
    let initialized = false;
    let resolveAnswer!: (value: unknown) => void;
    let rejectAnswer!: (error: Error) => void;
    const answer = new Promise<unknown>((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    const fail = (status: ProviderUsage['status'], detail: string) => {
      if (finished) return;
      finished = true;
      failResult(status, detail);
      rejectAnswer(new Error(detail));
      void running.stop();
    };
    const send = (id: string, request: RecordValue) => {
      try {
        running.child.stdin.write(
          JSON.stringify({ type: 'control_request', request_id: id, request }) +
            '\n',
        );
      } catch {
        fail('error', 'Claude Code closed during usage inspection.');
      }
    };
    let outputBytes = 0;
    running.child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 4 * maxLineBytes)
        fail('error', 'Claude Code usage inspection returned too much data.');
    });
    detach = readFrames(
      running.child.stdout,
      maxLineBytes,
      value => {
        if (finished) return;
        const frame = object(value);
        if (frame?.type === 'control_request') {
          fail(
            'error',
            'Claude Code requested an operation during usage inspection.',
          );
          return;
        }
        if (frame?.type !== 'control_response') return;
        const response = object(frame.response);
        const expected = initialized ? usageId : initializeId;
        if (response?.request_id !== expected) return;
        if (response.subtype !== 'success') {
          const message =
            typeof response.error === 'string'
              ? response.error.toLowerCase()
              : '';
          if (
            /not logged|not authenticated|authentication required|unauthenticated/.test(
              message,
            )
          )
            fail(
              'unauthenticated',
              'Sign in with Claude Code, then refresh its limits.',
            );
          else if (
            /unsupported|unknown|unrecognized|not implemented/.test(message)
          )
            fail(
              'unavailable',
              'This Claude Code version does not support native usage inspection. Update the CLI or inspect /usage in Claude Code.',
            );
          else
            fail(
              'error',
              'Claude Code could not read its account limits. Try again later.',
            );
          return;
        }
        if (!initialized) {
          account = object(response.response)?.account;
          initialized = true;
          send(usageId, { subtype: 'get_usage', skip_behaviors: true });
        } else {
          finished = true;
          resolveAnswer(response.response);
        }
      },
      () => fail('error', 'Claude Code returned an invalid usage frame.'),
    );
    running.child.stderr.resume();
    abort = () => fail('error', 'Claude Code usage inspection stopped.');
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(
      () => fail('error', 'Claude Code usage inspection timed out.'),
      15_000,
    );
    if (signal?.aborted) abort();
    else
      send(initializeId, {
        subtype: 'initialize',
        hooks: {},
        sdkMcpServers: [],
      });
    const value = await Promise.race([
      answer,
      running.closed.then(() => {
        throw new Error('Claude Code closed before returning usage data.');
      }),
    ]);
    result = claudeUsageResult(value, account);
  } catch {
    if (!failureReported)
      failResult(
        'unavailable',
        signal?.aborted
          ? 'Claude Code usage inspection stopped.'
          : 'Claude Code did not return native usage data. Update the CLI or inspect /usage in Claude Code.',
      );
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    detach?.();
    if (owned) {
      owned.child.stdin.end();
      await Promise.race([owned.closed, wait(300)]);
      await owned.stop();
      const exit = await owned.closed;
      if (!exit.confirmed)
        failResult(
          'error',
          'Claude Code usage process cleanup could not be confirmed.',
        );
    }
  }
  if (signal?.aborted)
    failResult('error', 'Claude Code usage inspection stopped.');
  return result;
}

export function startClaude(options: {
  directory: string;
  sessionId: string;
  resume: boolean;
  model: string;
  prompt: string;
  onEvent: (event: ClaudeEvent) => void;
}): { done: Promise<ClaudeResult>; stop: () => Promise<void> } {
  let stopped = false;
  let owned: OwnedProcess | null = null;
  const done = (async (): Promise<ClaudeResult> => {
    let failure: string | null = null;
    try {
      if (!models.some(model => model.id === options.model))
        throw new Error(
          'Unsupported Claude model. Choose default, opus, sonnet or haiku.',
        );
      if (
        !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
          options.sessionId,
        )
      )
        throw new Error('Claude session ID must be a UUID.');
      if (!isAbsolute(options.directory))
        throw new Error('Claude working directory must be an absolute path.');
      const inspection = await inspect(() => stopped);
      if (stopped) return { status: 'stopped', error: null };
      if (inspection.status.status !== 'ready' || !inspection.executable)
        throw new Error(
          inspection.status.detail ?? 'Claude Code is unavailable.',
        );
      const args = [
        '--print',
        '--input-format',
        'text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        'plan',
        '--permission-prompts',
        'none',
        '--tools',
        'Read,Glob,Grep',
        '--allowedTools',
        'Read,Glob,Grep',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--settings',
        '{"disableAllHooks":true}',
        options.resume ? '--resume' : '--session-id',
        options.sessionId,
      ];
      if (options.model !== 'default') args.push('--model', options.model);
      if (stopped) return { status: 'stopped', error: null };
      owned = ownProcess(inspection.executable, args, options.directory);
      const running = owned;
      const messages = new Map<
        string,
        { text: string; blocks: Map<number, string> }
      >();
      const toolActivities = new Map<string, ProviderActivity>();
      let currentMessage: string | null = null;
      let sequence = 0;
      let lastText = '';
      let line = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stderr = '';
      let resultSeen = false;
      let successful = false;
      let initialized = false;
      let providerFailure: string | null = null;
      let rateLimitFailure: string | null = null;
      const fail = (message: string) => {
        failure ??= safeMessage(message);
        void running.stop();
      };
      const emit = (event: ClaudeEvent) => {
        if (failure || stopped) return;
        try {
          options.onEvent(event);
        } catch {
          fail('Claude event delivery failed.');
        }
      };
      const publish = () => {
        const text = [...messages.values()]
          .map(message => message.text)
          .join('');
        if (Buffer.byteLength(text) > maxTextBytes) {
          fail('Claude response exceeded the supported size.');
        } else if (text !== lastText) {
          lastText = text;
          emit({ type: 'text', text });
        }
      };
      const activity = (block: RecordValue | null) => {
        if (
          block?.type === 'tool_use' &&
          typeof block.name === 'string' &&
          ['Read', 'Glob', 'Grep'].includes(block.name)
        ) {
          emit({ type: 'activity', text: block.name });
          if (typeof block.id !== 'string') return;
          const previous = toolActivities.get(block.id);
          const input = object(block.input);
          const paths = [input?.file_path, input?.path].filter(
            (value): value is string => typeof value === 'string',
          );
          const detail =
            [typeof input?.pattern === 'string' ? input.pattern : '', ...paths]
              .filter(Boolean)
              .join('\n') || null;
          const next = makeActivity({
            id: block.id,
            kind: block.name === 'Read' ? 'read' : 'search',
            title:
              block.name === 'Read'
                ? 'Read file'
                : block.name === 'Glob'
                  ? 'Find files'
                  : 'Search files',
            status: previous?.status ?? 'running',
            startedAt: previous?.startedAt,
            completedAt: previous?.completedAt,
            detail: detail ?? previous?.detail,
            output: previous?.output,
            paths: paths.length ? paths : previous?.paths,
            truncated: previous?.truncated,
          });
          toolActivities.set(next.id, next);
          emit({ type: 'tool-activity', activity: next });
        }
      };
      const consume = (serialized: string) => {
        if (!serialized.trim() || failure || stopped) return;
        let value: RecordValue | null;
        try {
          value = object(JSON.parse(serialized) as unknown);
        } catch {
          fail('Claude returned malformed streaming JSON.');
          return;
        }
        if (!value || typeof value.type !== 'string') {
          fail('Claude returned an invalid streaming message.');
          return;
        }
        if (value.parent_tool_use_id) return;
        if (value.type === 'system' && value.subtype === 'init') {
          if (
            typeof value.session_id !== 'string' ||
            typeof value.model !== 'string'
          ) {
            fail('Claude returned invalid session metadata.');
          } else {
            initialized = true;
            emit({
              type: 'init',
              sessionId: value.session_id,
              model: value.model,
            });
          }
        } else if (value.type === 'stream_event') {
          const event = object(value.event);
          if (event?.type === 'message_start') {
            const message = object(event.message);
            currentMessage =
              typeof message?.id === 'string'
                ? message.id
                : `stream-${sequence++}`;
            if (!messages.has(currentMessage))
              messages.set(currentMessage, { text: '', blocks: new Map() });
          } else if (currentMessage && typeof event?.index === 'number') {
            const message = messages.get(currentMessage)!;
            if (event.type === 'content_block_start') {
              const block = object(event.content_block);
              activity(block);
              if (block?.type === 'text' && typeof block.text === 'string')
                message.blocks.set(event.index, block.text);
            } else if (event.type === 'content_block_delta') {
              const delta = object(event.delta);
              if (
                delta?.type === 'text_delta' &&
                typeof delta.text === 'string'
              ) {
                message.blocks.set(
                  event.index,
                  (message.blocks.get(event.index) ?? '') + delta.text,
                );
              }
            }
            message.text = [...message.blocks.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, text]) => text)
              .join('');
            if (!providerFailure && !rateLimitFailure) publish();
          }
        } else if (value.type === 'assistant') {
          const message = object(value.message);
          if (value.error || message?.error) {
            const content = Array.isArray(message?.content)
              ? message.content
                  .map(object)
                  .filter(block => block?.type === 'text')
                  .map(block => block?.text)
                  .filter(text => typeof text === 'string')
                  .join('')
              : '';
            providerFailure = safeMessage(
              content ||
                `Claude failed: ${typeof value.error === 'string' ? value.error : 'provider error'}.`,
            );
            if (typeof message?.id === 'string' && messages.delete(message.id))
              publish();
            return;
          }
          if (!message || !Array.isArray(message.content)) {
            fail('Claude returned an invalid assistant message.');
            return;
          }
          const id =
            typeof message.id === 'string'
              ? message.id
              : (currentMessage ?? `assistant-${sequence++}`);
          const existing = messages.get(id);
          const blocks = message.content.map(object);
          for (const block of blocks) activity(block);
          const text = blocks
            .filter(block => block?.type === 'text')
            .map(block => (typeof block?.text === 'string' ? block.text : ''))
            .join('');
          if (!existing) {
            messages.set(id, { text, blocks: new Map() });
          } else if (blocks.some(block => block?.type === 'text')) {
            existing.text = text;
          }
          if (!providerFailure && !rateLimitFailure) publish();
        } else if (value.type === 'user') {
          const message = object(value.message);
          if (!Array.isArray(message?.content)) return;
          for (const content of message.content) {
            const block = object(content);
            if (
              block?.type !== 'tool_result' ||
              typeof block.tool_use_id !== 'string'
            )
              continue;
            const previous = toolActivities.get(block.tool_use_id);
            if (!previous || previous.status !== 'running') continue;
            const failed = block.is_error === true;
            const next = makeActivity({
              ...previous,
              status: failed ? 'failed' : 'completed',
              output:
                failed && typeof block.content === 'string'
                  ? block.content
                  : '',
            });
            toolActivities.set(next.id, next);
            emit({ type: 'tool-activity', activity: next });
          }
        } else if (value.type === 'result') {
          resultSeen = true;
          successful = value.is_error === false && value.subtype === 'success';
          if (!successful) {
            const errors = Array.isArray(value.errors)
              ? value.errors
                  .filter(error => typeof error === 'string')
                  .join(' ')
              : '';
            providerFailure = safeMessage(
              typeof value.result === 'string' && value.result
                ? value.result
                : errors ||
                    providerFailure ||
                    rateLimitFailure ||
                    'Claude did not complete the turn.',
            );
          } else if (
            !lastText &&
            !providerFailure &&
            !rateLimitFailure &&
            typeof value.result === 'string' &&
            value.result
          ) {
            messages.set('result-fallback', {
              text: value.result,
              blocks: new Map(),
            });
            publish();
          }
        } else if (value.type === 'rate_limit_event') {
          const info = object(value.rate_limit_info);
          if (info?.status === 'rejected') {
            const reset = info.resetsAt;
            const date =
              typeof reset === 'number'
                ? new Date(reset < 1e12 ? reset * 1000 : reset)
                : typeof reset === 'string'
                  ? new Date(reset)
                  : null;
            rateLimitFailure =
              date && Number.isFinite(date.getTime())
                ? `Claude usage limit reached. Resets at ${date.toISOString()}.`
                : 'Claude usage limit reached. Check Claude Code for the reset time.';
          }
        } else if (value.type === 'error') {
          const error = object(value.error);
          providerFailure = safeMessage(
            typeof error?.message === 'string'
              ? error.message
              : 'Claude could not continue. Check account limits and authentication.',
          );
        }
      };
      running.child.stdout.setEncoding('utf8');
      running.child.stderr.setEncoding('utf8');
      running.child.stdout.on('data', (chunk: string) => {
        if (failure || stopped) return;
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxOutputBytes) {
          fail('Claude streaming output exceeded the supported size.');
          return;
        }
        line += chunk;
        let newline: number;
        while ((newline = line.indexOf('\n')) !== -1) {
          const next = line.slice(0, newline);
          line = line.slice(newline + 1);
          if (Buffer.byteLength(next) > maxLineBytes) {
            fail('Claude streaming message exceeded the supported size.');
            return;
          }
          consume(next);
        }
        if (Buffer.byteLength(line) > maxLineBytes)
          fail('Claude streaming message exceeded the supported size.');
      });
      running.child.stderr.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes <= 16_384) stderr += chunk;
      });
      const timer = setTimeout(
        () => fail('Claude turn timed out after ten minutes.'),
        runTimeoutMs,
      );
      running.child.stdin.end(options.prompt);
      let exit: ProcessExit;
      try {
        exit = await Promise.race([
          running.closed,
          wait(runTimeoutMs + cleanupTimeoutMs * 2).then(() => {
            throw new Error('Claude process did not close after cleanup.');
          }),
        ]);
        if (line) consume(line);
      } finally {
        clearTimeout(timer);
        await running.stop();
      }
      if (failure) return { status: 'failed', error: failure };
      if (!exit.confirmed)
        return {
          status: 'failed',
          error: 'Claude process closure could not be confirmed after cleanup.',
        };
      if (providerFailure || rateLimitFailure)
        return { status: 'failed', error: providerFailure ?? rateLimitFailure };
      if (stopped && resultSeen && successful && lastText)
        return { status: 'completed', error: null };
      if (stopped) return { status: 'stopped', error: null };
      if (!resultSeen && initialized)
        return {
          status: 'interrupted',
          interruption: 'provider-disconnected',
          error:
            'Claude Code disconnected before confirming the turn outcome. Inspect the workspace before continuing.',
        };
      if (exit.error)
        throw new Error(
          'Claude Code process failed. Check the executable and working directory.',
        );
      if (exit.code !== 0)
        throw new Error(
          stderr.trim()
            ? `Claude Code exited with code ${exit.code}: ${safeMessage(stderr.trim())}`
            : `Claude Code exited with code ${exit.code}.`,
        );
      if (!resultSeen || !successful)
        throw new Error('Claude Code exited without a successful result.');
      if (!lastText)
        throw new Error('Claude Code completed without an assistant response.');
      return { status: 'completed', error: null };
    } catch (error) {
      await owned?.stop();
      return failure
        ? { status: 'failed', error: failure }
        : stopped
          ? { status: 'stopped', error: null }
          : {
              status: 'failed',
              error: safeMessage(
                error instanceof Error ? error.message : 'Claude Code failed.',
              ),
            };
    }
  })();
  return {
    done,
    stop: async () => {
      stopped = true;
      await owned?.stop();
      await done;
    },
  };
}
