import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  activityLimits,
  promptQuestionSchema,
  type ClaudeStatus,
  type PromptAnswer,
  type PromptQuestion,
  type ProviderUsage,
  type SessionFailure,
  type SessionMode,
  type TurnUsage,
} from '@nesvo/contracts';
import { readFrames } from '../daemon-channel';
import { makeActivity, type ProviderActivity } from './activity';
import {
  ProviderFailureError,
  sessionFailure,
  textFailureKind,
  type FailureKind,
} from './failure';
import { claudeUsageResult } from './claude-usage';
import {
  descendantScanMs,
  recordDescendants,
  signalRecorded,
} from './process-tree';
import { claudeTurnUsage } from './turn-usage';

export type ClaudeEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'tool-activity'; activity: ProviderActivity }
  | { type: 'prompt'; prompt: ClaudePrompt }
  | { type: 'prompt-resolved'; id: string };

export type ClaudePrompt = {
  id: string;
  kind: 'question' | 'plan';
  questions: PromptQuestion[];
  plan: string | null;
  planRound: number;
};

export type ClaudeResult = {
  status: 'completed' | 'stopped' | 'failed' | 'interrupted';
  error: string | null;
  interruption?: 'provider-disconnected';
  usage?: TurnUsage;
  limit?: { resetsAt: string | null };
  structured?: unknown;
  modeUnavailable?: true;
  planAccepted?: { mode: SessionMode; plan: string };
  failure?: SessionFailure;
};

type PendingPrompt = {
  prompt: ClaudePrompt;
  questions: unknown;
};

type Executable = { command: string; prefix: string[] };
type ClaudeMode = Exclude<SessionMode, 'supervised'>;
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
  '--json-schema',
  '--no-session-persistence',
  '--setting-sources',
  '--model',
];
const readTools = ['Read', 'Glob', 'Grep'];
const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const claudeModes = {
  'read-only': { cli: 'plan', tools: readTools, allowed: readTools },
  'accept-edits': {
    cli: 'acceptEdits',
    tools: [...readTools, ...editTools],
    allowed: readTools,
  },
  auto: {
    cli: 'auto',
    tools: [...readTools, ...editTools, 'Bash'],
    allowed: readTools,
  },
} as const satisfies Record<
  ClaudeMode,
  { cli: string; tools: string[]; allowed: string[] }
>;
const optionalModes = ['accept-edits', 'auto'] as const;
const modeLabels = {
  'read-only': 'Plan',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
} as const satisfies Record<ClaudeMode, string>;
const questionTool = 'AskUserQuestion';
const planTools = ['ExitPlanMode', 'Write'];
const planEditTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const maxPendingPrompts = 10;
const maxPlanLength = 40_000;
const maxPlanFileBytes = 1024 * 1024;
const promptQuestionsSchema = z.array(promptQuestionSchema).min(1).max(10);
const toolPresentation = {
  Read: { kind: 'read', title: 'Read file' },
  Glob: { kind: 'search', title: 'Find files' },
  Grep: { kind: 'search', title: 'Search files' },
  Edit: { kind: 'file-change', title: 'Edit file' },
  MultiEdit: { kind: 'file-change', title: 'Edit file' },
  Write: { kind: 'file-change', title: 'Write file' },
  NotebookEdit: { kind: 'file-change', title: 'Edit notebook' },
  Bash: { kind: 'command', title: 'Run command' },
} as const satisfies Record<
  string,
  { kind: ProviderActivity['kind']; title: string }
>;
const maxLineBytes = 1024 * 1024;
const maxOutputBytes = 16 * 1024 * 1024;
const maxTextBytes = 2_000_000;
const thinkingEmitIntervalMs = 250;
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

function permissionChoices(help: string): string[] {
  const flag = '--permission-mode';
  const start = help.indexOf(flag);
  if (start < 0) return [];
  const rest = help.slice(start + flag.length);
  const end = rest.search(/\n\s*-/);
  const segment = end < 0 ? rest : rest.slice(0, end);
  const choices = /\(choices:([^)]*)\)/.exec(segment)?.[1] ?? '';
  return [...choices.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
}

function supportedModes(choices: string[]): ClaudeMode[] {
  return [
    'read-only',
    ...optionalModes.filter(mode => choices.includes(claudeModes[mode].cli)),
  ];
}

let lastReadyModes: ClaudeMode[] | null = null;

export function reportedClaudeModes(): SessionMode[] | null {
  return lastReadyModes ? [...lastReadyModes] : null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(object)
    .map(item =>
      item?.type === 'text' && typeof item.text === 'string' ? item.text : '',
    )
    .filter(Boolean)
    .join('\n');
}

function isClaudeMode(mode: SessionMode): mode is ClaudeMode {
  return mode in claudeModes;
}

function promptQuestions(value: unknown): PromptQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = promptQuestionsSchema.safeParse(
    value.map(item => {
      const question = object(item);
      return {
        question: question?.question,
        header: question?.header ?? '',
        options: Array.isArray(question?.options)
          ? question.options.map(option => {
              const choice = object(option);
              return {
                label: choice?.label,
                description: choice?.description ?? '',
              };
            })
          : question?.options,
        multiSelect: question?.multiSelect === true,
      };
    }),
  );
  return parsed.success ? parsed.data : null;
}

function within(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference !== '' &&
    !isAbsolute(difference) &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`)
  );
}

async function readPlanFile(
  path: unknown,
  configDirectory: string | undefined,
): Promise<string | null> {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  const roots = [
    join(homedir(), '.claude', 'plans'),
    ...(configDirectory && isAbsolute(configDirectory)
      ? [join(configDirectory, 'plans')]
      : []),
  ];
  try {
    const resolved = await realpath(path);
    const allowed = await Promise.all(
      roots.map(root => realpath(root).catch(() => null)),
    );
    if (!allowed.some(root => root !== null && within(root, resolved)))
      return null;
    const file = await stat(resolved);
    if (!file.isFile() || file.size > maxPlanFileBytes) return null;
    const text = (await readFile(resolved, 'utf8')).trim();
    return text ? text.slice(0, maxPlanLength) : null;
  } catch {
    return null;
  }
}

function refusalDetail(input: RecordValue): string | null {
  return (
    [
      input.description,
      input.command,
      input.file_path,
      input.notebook_path,
      input.path,
      input.pattern,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n') || null
  );
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
            error: new Error('Claude process did not close after cleanup.'),
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
  permissionModes: string[];
}> {
  let version: string | null = null;
  let permissionModes: string[] = [];
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
    modes: state === 'ready' ? supportedModes(permissionModes) : [],
  });
  try {
    const executable = await executablePath();
    if (!executable) {
      return {
        executable: null,
        permissionModes,
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
        permissionModes,
        status: status('error', 'Claude Code version inspection failed.'),
      };
    }
    version =
      /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(versionResult.stdout)?.[0] ??
      null;
    permissionModes = permissionChoices(help.stdout);
    const missing = requiredFlags.filter(flag => !help.stdout.includes(flag));
    if (help.code !== 0 || missing.length > 0 || !version) {
      return {
        executable,
        permissionModes,
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
        permissionModes,
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
        permissionModes,
        status: status(
          'unauthenticated',
          'Sign in with claude auth login, then refresh Claude Code status.',
        ),
      };
    }
    if (auth.code !== 0 || authentication?.loggedIn !== true) {
      return {
        executable,
        permissionModes,
        status: status(
          'error',
          'Claude Code authentication could not be verified.',
        ),
      };
    }
    const ready = status('ready', null);
    lastReadyModes = ready.modes.filter(isClaudeMode);
    return { executable, status: ready, permissionModes };
  } catch (error) {
    return {
      executable: null,
      permissionModes,
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
  environment?: Readonly<Record<string, string>>;
  outputSchema?: Record<string, unknown>;
  ephemeral?: boolean;
  instructionsOnly?: boolean;
  assistantPrompt?: string;
  mode: SessionMode;
  onEvent: (event: ClaudeEvent) => void;
}): {
  done: Promise<ClaudeResult>;
  stop: () => Promise<void>;
  answerPrompt: (id: string, answer: PromptAnswer) => void;
} {
  let stopped = false;
  let owned: OwnedProcess | null = null;
  const prompts = new Map<string, PendingPrompt>();
  let answer: ((id: string, value: PromptAnswer) => void) | null = null;
  let requestStop!: () => void;
  const stopRequested = new Promise<void>(resolve => {
    requestStop = resolve;
  });
  const releasePrompts = () => {
    for (const id of [...prompts.keys()]) {
      prompts.delete(id);
      try {
        options.onEvent({ type: 'prompt-resolved', id });
      } catch {
        continue;
      }
    }
  };
  const done = (async (): Promise<ClaudeResult> => {
    let failure: string | null = null;
    let failureKind: FailureKind = 'provider';
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
      if (!isClaudeMode(options.mode))
        throw new Error(
          'Claude Code does not support this permission mode. Choose Plan, Accept edits or Auto.',
        );
      const inspection = await inspect(() => stopped);
      if (stopped) return { status: 'stopped', error: null };
      if (inspection.status.status !== 'ready' || !inspection.executable)
        throw new ProviderFailureError(
          sessionFailure(
            inspection.status.status === 'unauthenticated'
              ? 'sign-in'
              : 'provider',
            safeMessage(
              inspection.status.detail ?? 'Claude Code is unavailable.',
            ),
          ),
        );
      if (!inspection.status.modes.includes(options.mode))
        return {
          status: 'failed',
          error:
            'This Claude Code version does not offer the selected permission mode. Update the CLI or choose Plan.',
          failure: sessionFailure(
            'provider',
            'This Claude Code version does not offer the selected permission mode. Update the CLI or choose Plan.',
          ),
          modeUnavailable: true,
        };
      const permission = claudeModes[options.mode];
      const assistantMode = ['dontAsk', 'default'].find(candidate =>
        inspection.permissionModes.includes(candidate),
      );
      const permissionMode =
        options.assistantPrompt && options.mode === 'read-only' && assistantMode
          ? assistantMode
          : permission.cli;
      const interactive = !options.outputSchema && !options.assistantPrompt;
      const planning = interactive && permissionMode === 'plan';
      const tools = [
        ...permission.tools,
        ...(interactive ? [questionTool] : []),
        ...(planning ? planTools : []),
      ].join(',');
      const allowedTools = permission.allowed.join(',');
      const args = [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        permissionMode,
        '--permission-prompts',
        'host',
        '--permission-prompt-tool',
        'stdio',
        '--tools',
        tools,
        '--allowedTools',
        allowedTools,
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--settings',
        '{"disableAllHooks":true}',
        options.resume ? '--resume' : '--session-id',
        options.sessionId,
      ];
      if (options.model !== 'default') args.push('--model', options.model);
      if (options.ephemeral) args.push('--no-session-persistence');
      if (options.instructionsOnly) args.push('--setting-sources', '');
      if (options.assistantPrompt)
        args.push('--append-system-prompt', options.assistantPrompt);
      if (options.outputSchema)
        args.push('--json-schema', JSON.stringify(options.outputSchema));
      if (stopped) return { status: 'stopped', error: null };
      owned = ownProcess(
        inspection.executable,
        args,
        options.directory,
        options.environment,
      );
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
      let usage: TurnUsage | null = null;
      const structured: { output?: { value: unknown } } = {};
      let successful = false;
      let initialized = false;
      let providerFailure: string | null = null;
      let providerFailureKind: FailureKind = 'provider';
      let rateLimitFailure: string | null = null;
      let rateLimitResetsAt: string | null = null;
      const initializeId = randomUUID();
      let userSent = false;
      let planRound = 0;
      let planAccepted: ClaudeResult['planAccepted'];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (message: string, kind: FailureKind = 'provider') => {
        if (!failure) failureKind = kind;
        failure ??= safeMessage(message);
        requestStop();
        void running.stop();
      };
      const reportProviderFailure = (message: string, evidence: string) => {
        providerFailure = safeMessage(message);
        providerFailureKind = textFailureKind(evidence) ?? 'provider';
      };
      const armTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => fail('Claude turn timed out after ten minutes.', 'timeout'),
          runTimeoutMs,
        );
      };
      const write = (frame: RecordValue) => {
        if (running.child.stdin.destroyed || running.child.stdin.writableEnded)
          throw new Error('Claude Code input is closed.');
        running.child.stdin.write(JSON.stringify(frame) + '\n');
      };
      const respond = (requestId: string, response: RecordValue) =>
        write({
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response },
        });
      const deliver = (send: () => void) => {
        try {
          send();
        } catch {
          fail('Claude Code input closed before Nesvo could answer.', 'crash');
        }
      };
      const emit = (event: ClaudeEvent) => {
        if (failure || stopped) return;
        try {
          options.onEvent(event);
        } catch {
          fail('Claude event delivery failed.', 'host');
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
          Object.hasOwn(toolPresentation, block.name)
        ) {
          const name = block.name as keyof typeof toolPresentation;
          emit({ type: 'activity', text: name });
          if (typeof block.id !== 'string') return;
          const previous = toolActivities.get(block.id);
          const input = object(block.input);
          const paths = [
            input?.file_path,
            input?.notebook_path,
            input?.path,
          ].filter((value): value is string => typeof value === 'string');
          const command =
            typeof input?.command === 'string' ? input.command : null;
          const detail =
            name === 'Bash'
              ? command
              : [
                  typeof input?.pattern === 'string' ? input.pattern : '',
                  ...paths,
                ]
                  .filter(Boolean)
                  .join('\n') || null;
          const next = makeActivity({
            id: block.id,
            kind: toolPresentation[name].kind,
            title: toolPresentation[name].title,
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
      const thinkingBlocks = new Map<
        string,
        {
          messageId: string;
          index: number;
          activity: ProviderActivity;
          text: string;
          emittedAt: number;
        }
      >();
      const thinkingId = (messageId: string, index: number) =>
        `${messageId}:thinking:${index}`;
      const updateThinking = (
        messageId: string,
        index: number,
        change: { delta?: string; text?: string; done?: boolean },
      ) => {
        const id = thinkingId(messageId, index);
        const previous = thinkingBlocks.get(id);
        if (previous?.activity.status === 'completed') return;
        const text = (
          change.text ?? (previous?.text ?? '') + (change.delta ?? '')
        ).slice(0, activityLimits.detail + 1);
        const now = Date.now();
        const done = change.done === true;
        if (
          previous &&
          !done &&
          now - previous.emittedAt < thinkingEmitIntervalMs
        ) {
          previous.text = text;
          return;
        }
        const next = makeActivity({
          id,
          kind: 'thinking',
          title: 'Thinking',
          status: done ? 'completed' : 'running',
          startedAt: previous?.activity.startedAt,
          detail: text || null,
        });
        thinkingBlocks.set(id, {
          messageId,
          index,
          activity: next,
          text,
          emittedAt: now,
        });
        emit({ type: 'tool-activity', activity: next });
      };
      const completeThinking = (messageId: string, index: number) => {
        if (thinkingBlocks.has(thinkingId(messageId, index)))
          updateThinking(messageId, index, { done: true });
      };
      const completeRecordedThinking = (
        messageId: string,
        blocks: (RecordValue | null)[],
      ) => {
        const tracked = [...thinkingBlocks.values()].filter(
          block => block.messageId === messageId,
        );
        if (tracked.length) {
          for (const block of tracked) completeThinking(messageId, block.index);
          return;
        }
        blocks.forEach((block, index) => {
          if (block?.type !== 'thinking') return;
          updateThinking(messageId, index, {
            text: typeof block.thinking === 'string' ? block.thinking : '',
            done: true,
          });
        });
      };
      const addPrompt = (prompt: ClaudePrompt, questions: unknown) => {
        prompts.set(prompt.id, { prompt, questions });
        clearTimeout(timer);
        emit({ type: 'prompt', prompt });
      };
      const refuse = (
        requestId: string,
        toolName: string,
        input: RecordValue,
        toolUseId: unknown,
      ) => {
        const message =
          planning && planEditTools.has(toolName)
            ? 'Plan mode is read-only in Nesvo. Describe the change instead.'
            : `Nesvo does not allow ${toolName} in ${modeLabels[options.mode as ClaudeMode]} mode.`;
        deliver(() => respond(requestId, { behavior: 'deny', message }));
        const id =
          typeof toolUseId === 'string' && toolUseId && toolUseId.length <= 200
            ? toolUseId
            : `refused-${requestId}`;
        const previous = toolActivities.get(id);
        const presentation = Object.hasOwn(toolPresentation, toolName)
          ? toolPresentation[toolName as keyof typeof toolPresentation]
          : null;
        const next = makeActivity({
          id,
          kind: presentation?.kind ?? 'tool',
          title: presentation?.title ?? `Refused ${toolName}`.slice(0, 200),
          status: 'declined',
          startedAt: previous?.startedAt,
          detail: previous?.detail ?? refusalDetail(input),
          paths: previous?.paths,
          truncated: previous?.truncated,
        });
        toolActivities.set(next.id, next);
        emit({ type: 'tool-activity', activity: next });
      };
      const requestPlan = async (requestId: string, input: RecordValue) => {
        const plan =
          (typeof input.plan === 'string' && input.plan.trim()
            ? input.plan.trim().slice(0, maxPlanLength)
            : null) ??
          (await readPlanFile(
            input.planFilePath,
            options.environment?.CLAUDE_CONFIG_DIR ??
              process.env.CLAUDE_CONFIG_DIR,
          )) ??
          'The model did not provide a plan.';
        if (failure || stopped) return;
        planRound += 1;
        addPrompt(
          {
            id: requestId,
            kind: 'plan',
            questions: [],
            plan,
            planRound,
          },
          null,
        );
      };
      const requestTool = (requestId: string, request: RecordValue) => {
        const toolName =
          typeof request.tool_name === 'string' && request.tool_name
            ? request.tool_name
            : 'an unnamed tool';
        const input = object(request.input) ?? {};
        if (prompts.has(requestId)) return;
        const prompting =
          (interactive && toolName === questionTool) ||
          (planning && toolName === 'ExitPlanMode');
        if (prompting && prompts.size >= maxPendingPrompts) {
          deliver(() =>
            respond(requestId, {
              behavior: 'deny',
              message:
                'Too many questions are waiting for the operator. Continue without asking.',
            }),
          );
          return;
        }
        if (interactive && toolName === questionTool) {
          const questions = promptQuestions(input.questions);
          if (!questions) {
            deliver(() =>
              respond(requestId, {
                behavior: 'deny',
                message:
                  'Nesvo could not show these questions. Continue without asking.',
              }),
            );
            return;
          }
          addPrompt(
            {
              id: requestId,
              kind: 'question',
              questions,
              plan: null,
              planRound: 1,
            },
            input.questions,
          );
        } else if (planning && toolName === 'ExitPlanMode') {
          requestPlan(requestId, input).catch(() =>
            fail('Nesvo could not read the proposed plan.'),
          );
        } else refuse(requestId, toolName, input, request.tool_use_id);
      };
      const control = (value: RecordValue) => {
        const requestId = value.request_id;
        const request = object(value.request);
        if (
          typeof requestId !== 'string' ||
          !requestId ||
          requestId.length > 200 ||
          !request
        ) {
          fail('Claude returned an invalid control request.');
          return;
        }
        if (request.subtype === 'can_use_tool') requestTool(requestId, request);
        else
          deliver(() =>
            write({
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: requestId,
                error: 'Nesvo does not support this request.',
              },
            }),
          );
      };
      answer = (id, value) => {
        const pending = prompts.get(id);
        if (!pending || failure || stopped)
          throw new Error('This prompt is no longer waiting for an answer.');
        if (pending.prompt.kind !== value.kind)
          throw new Error('This answer does not match the prompt.');
        if (value.kind === 'question') {
          respond(id, {
            behavior: 'allow',
            updatedInput: {
              questions: pending.questions,
              answers: value.answers,
            },
          });
        } else if (value.decision === 'accept') {
          respond(id, {
            behavior: 'deny',
            message: `The operator accepted the plan and chose ${modeLabels[value.mode]}. Stop now without further changes; the work continues in the next turn with that access.`,
          });
          planAccepted = {
            mode: value.mode,
            plan: pending.prompt.plan ?? '',
          };
        } else {
          respond(id, {
            behavior: 'deny',
            message: `The operator asks for changes before accepting the plan: ${value.feedback}. Revise the plan and call ExitPlanMode again.`,
          });
        }
        prompts.delete(id);
        if (!prompts.size) armTimeout();
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
        if (value.type === 'control_request') {
          control(value);
        } else if (value.type === 'control_response') {
          const response = object(value.response);
          if (userSent || response?.request_id !== initializeId) return;
          if (response.subtype !== 'success') {
            fail(
              'Claude Code did not accept the session handshake. Update the CLI.',
            );
            return;
          }
          userSent = true;
          deliver(() =>
            write({
              type: 'user',
              message: {
                role: 'user',
                content: [{ type: 'text', text: options.prompt }],
              },
            }),
          );
        } else if (value.type === 'control_cancel_request') {
          const id = value.request_id;
          if (typeof id === 'string' && prompts.delete(id)) {
            emit({ type: 'prompt-resolved', id });
            if (!prompts.size) armTimeout();
          }
        } else if (value.type === 'system' && value.subtype === 'init') {
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
              if (block?.type === 'thinking')
                updateThinking(currentMessage, event.index, {
                  text:
                    typeof block.thinking === 'string' ? block.thinking : '',
                });
            } else if (event.type === 'content_block_stop') {
              completeThinking(currentMessage, event.index);
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
              if (
                delta?.type === 'thinking_delta' &&
                typeof delta.thinking === 'string'
              )
                updateThinking(currentMessage, event.index, {
                  delta: delta.thinking,
                });
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
            const code =
              typeof value.error === 'string'
                ? value.error
                : typeof message?.error === 'string'
                  ? message.error
                  : '';
            reportProviderFailure(
              content || `Claude failed: ${code || 'provider error'}.`,
              `${code} ${content}`,
            );
            if (code === 'rate_limit') providerFailureKind = 'usage-limit';
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
          completeRecordedThinking(id, blocks);
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
              output: failed ? toolResultText(block.content) : '',
            });
            toolActivities.set(next.id, next);
            emit({ type: 'tool-activity', activity: next });
          }
        } else if (value.type === 'result') {
          resultSeen = true;
          releasePrompts();
          if (!running.child.stdin.destroyed) running.child.stdin.end();
          usage = claudeTurnUsage(value);
          successful = value.is_error === false && value.subtype === 'success';
          if (options.outputSchema && 'structured_output' in value)
            structured.output = { value: value.structured_output };
          if (!successful) {
            const errors = Array.isArray(value.errors)
              ? value.errors
                  .filter(error => typeof error === 'string')
                  .join(' ')
              : '';
            const reported =
              typeof value.result === 'string' && value.result
                ? value.result
                : errors;
            const previousKind = providerFailure
              ? providerFailureKind
              : 'provider';
            providerFailure = safeMessage(
              reported ||
                providerFailure ||
                rateLimitFailure ||
                'Claude did not complete the turn.',
            );
            providerFailureKind =
              (reported ? textFailureKind(reported) : null) ?? previousKind;
          } else if (!lastText && !providerFailure && !rateLimitFailure) {
            const fallback =
              typeof value.result === 'string' && value.result
                ? value.result
                : structured.output
                  ? JSON.stringify(structured.output.value, null, 2)
                  : '';
            if (fallback) {
              messages.set('result-fallback', {
                text: fallback,
                blocks: new Map(),
              });
              publish();
            }
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
            rateLimitResetsAt =
              date && Number.isFinite(date.getTime())
                ? date.toISOString()
                : null;
            rateLimitFailure = rateLimitResetsAt
              ? `Claude usage limit reached. Resets at ${rateLimitResetsAt}.`
              : 'Claude usage limit reached. Check Claude Code for the reset time.';
          }
        } else if (value.type === 'error') {
          const error = object(value.error);
          reportProviderFailure(
            typeof error?.message === 'string'
              ? error.message
              : 'Claude could not continue. Check account limits and authentication.',
            typeof error?.message === 'string' ? error.message : '',
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
      armTimeout();
      deliver(() =>
        write({
          type: 'control_request',
          request_id: initializeId,
          request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] },
        }),
      );
      let exit: ProcessExit;
      try {
        exit = await Promise.race([
          running.closed,
          stopRequested
            .then(() => wait(cleanupTimeoutMs * 3))
            .then(() => {
              throw new ProviderFailureError(
                sessionFailure(
                  'crash',
                  'Claude process did not close after cleanup.',
                ),
              );
            }),
        ]);
        if (line) consume(line);
      } finally {
        clearTimeout(timer);
        answer = null;
        releasePrompts();
        await running.stop();
      }
      const reported = {
        ...(usage ? { usage } : {}),
        ...(structured.output ? { structured: structured.output.value } : {}),
      };
      if (failure)
        return {
          status: 'failed',
          error: failure,
          failure: sessionFailure(failureKind, failure),
        };
      if (!exit.confirmed)
        return {
          status: 'failed',
          error: 'Claude process closure could not be confirmed after cleanup.',
          failure: sessionFailure(
            'crash',
            'Claude process closure could not be confirmed after cleanup.',
          ),
        };
      if (providerFailure || rateLimitFailure) {
        const error = (providerFailure ?? rateLimitFailure)!;
        return {
          status: 'failed',
          error,
          failure: rateLimitFailure
            ? sessionFailure('usage-limit', error, {
                resetsAt: rateLimitResetsAt,
              })
            : sessionFailure(providerFailureKind, error),
          ...reported,
          ...(rateLimitFailure
            ? { limit: { resetsAt: rateLimitResetsAt } }
            : {}),
        };
      }
      if (stopped && resultSeen && successful && lastText)
        return { status: 'completed', error: null, ...reported };
      if (stopped) return { status: 'stopped', error: null, ...reported };
      if (!resultSeen && initialized)
        return {
          status: 'interrupted',
          interruption: 'provider-disconnected',
          error:
            'Claude Code disconnected before confirming the turn outcome. Inspect the workspace before continuing.',
        };
      if (exit.error)
        throw new ProviderFailureError(
          sessionFailure(
            'crash',
            'Claude Code process failed. Check the executable and working directory.',
          ),
        );
      if (exit.code !== 0) {
        const output = safeMessage(stderr.trim());
        const message = output
          ? `Claude Code exited with code ${exit.code}: ${output}`
          : `Claude Code exited with code ${exit.code}.`;
        throw new ProviderFailureError(
          sessionFailure(textFailureKind(output) ?? 'crash', message, {
            exitCode: exit.code,
            detail: stderr.trim()
              ? safeMessage(stderr.trim().slice(-4000))
              : null,
          }),
        );
      }
      if (!resultSeen || !successful)
        throw new Error('Claude Code exited without a successful result.');
      if (!lastText)
        throw new Error('Claude Code completed without an assistant response.');
      return {
        status: 'completed',
        error: null,
        ...reported,
        ...(planAccepted ? { planAccepted } : {}),
      };
    } catch (error) {
      await owned?.stop();
      if (failure)
        return {
          status: 'failed',
          error: failure,
          failure: sessionFailure(failureKind, failure),
        };
      if (stopped) return { status: 'stopped', error: null };
      if (error instanceof ProviderFailureError)
        return {
          status: 'failed',
          error: error.message,
          failure: error.failure,
        };
      const message = safeMessage(
        error instanceof Error ? error.message : 'Claude Code failed.',
      );
      return {
        status: 'failed',
        error: message,
        failure: sessionFailure('provider', message),
      };
    }
  })();
  return {
    done,
    stop: async () => {
      stopped = true;
      requestStop();
      await owned?.stop();
      await done;
    },
    answerPrompt: (id, value) => {
      if (!answer)
        throw new Error('This prompt is no longer waiting for an answer.');
      answer(id, value);
    },
  };
}
