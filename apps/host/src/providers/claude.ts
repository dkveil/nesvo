import type { ProviderToolSubject, TurnGate } from '../inbox-rules/turn-gate';
import {
  claudeAllowCandidate,
  type AllowCandidate,
} from './claude-allow-pattern';
import type { VerifyMcpTurn } from '../mcp/service';
import { writeClaudeRunConfig } from '../mcp/claude-config-file';
import { spawn } from 'node:child_process';
import { providerEnvironment } from './profiles';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  activityLimits,
  claudeCommandLimits,
  reasoningEffortSchema,
  SESSION_CONTROL_NAMESPACE,
  sessionControlToolTitle,
  type Approval,
  type ImageMediaType,
  type ClaudeCommand,
  type ClaudeStatus,
  type ProviderUsage,
  type SessionMode,
  type TurnUsage,
} from '@nesvo/contracts';
import { readFrames } from '../daemon-channel';
import {
  cleanupTimeoutMs,
  terminateGraceMs,
  trackProcessTree,
  wait,
} from '../process/terminate-tree';
import { makeActivity, type ProviderActivity } from './activity';
import {
  claudeBrowserExtensionInstalled,
  claudeBrowserServerName,
  unattendedBrowserTools,
} from './browser-extension';
import {
  inactivityFailure,
  maxTurnOutputBytes,
  providerInactivityLimit,
  watchInactivity,
} from './inactivity';
import { interleave } from './interleave';
import {
  claudeApprovalTimeoutMs,
  claudeControlError,
  claudePermissionAnswer,
  parseClaudePermissionRequest,
} from './claude-approvals';
import { claudeUsageResult } from './claude-usage';
import {
  claudeMcpStatus,
  finishNativeMcpCommand,
  mcpStatusMap,
  type NativeMcpAction,
} from './mcp-native';
import type { ConfigTable } from '../mcp/scoped-config';
import {
  claudeContextFill,
  claudeTurnUsage,
  type ContextFill,
} from './turn-usage';
import { recordProviderProcess } from '../process/provider-processes';
import {
  claudeControlInitialize,
  claudeControlToolNames,
  createClaudeControlChannel,
  isClaudeControlServer,
  isClaudeMcpMessage,
  withoutControlServer,
} from './claude-control';
import type { SessionControlTurn } from '../session-control/types';
import { PLAN_RECEIVED_MESSAGE } from '../sessions/stages';

import { providerQuestion } from './turn-question';
import type { TurnQuestion } from '@nesvo/contracts';

export type ClaudeEvent =
  | { type: 'question'; questions: TurnQuestion }
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'tool-activity'; activity: ProviderActivity }
  | {
      type: 'approval';
      approval: Approval;
      subject?: ProviderToolSubject;
      candidate?: AllowCandidate;
      recheckRule?: () => AllowCandidate | { reason: string };
    }
  | { type: 'approval-resolved'; id: string }
  | { type: 'plan'; text: string };

export type ClaudeResult = {
  status: 'completed' | 'stopped' | 'failed' | 'interrupted';
  error: string | null;
  interruption?: 'provider-disconnected';
  usage?: TurnUsage;
  limit?: { resetsAt: string | null };
  structured?: unknown;
  modeUnavailable?: true;
  effortUnavailable?: true;
  context?: ContextFill;
  compacted?: true;
};

export type ClaudeImage = {
  mediaType: ImageMediaType | 'application/pdf';
  data: string;
  offset?: number;
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
const isolatedMcpArgs = [
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
];
const isolatedToolArgs = [
  ...isolatedMcpArgs,
  '--settings',
  '{"disableAllHooks":true}',
];
const readTools = ['Read', 'Glob', 'Grep'];
const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const workTools = ['TodoWrite', 'Agent', 'Skill'];
const workAllowed = [...readTools, 'TodoWrite'];
const claudeModes = {
  'read-only': { cli: 'plan', tools: readTools, allowed: readTools },
  'accept-edits': {
    cli: 'acceptEdits',
    tools: [...readTools, ...editTools, ...workTools],
    allowed: workAllowed,
  },
  auto: {
    cli: 'auto',
    tools: [...readTools, ...editTools, 'Bash', ...workTools],
    allowed: workAllowed,
  },
  'full-access': {
    cli: 'bypassPermissions',
    tools: [...readTools, ...editTools, 'Bash', ...workTools],
    allowed: workAllowed,
  },
} as const satisfies Record<
  ClaudeMode,
  { cli: string; tools: string[]; allowed: string[] }
>;
const optionalModes = ['accept-edits', 'auto', 'full-access'] as const;
const EXIT_PLAN_TOOL = 'ExitPlanMode';
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_BROWSER_MESSAGE =
  'While planning, Nesvo only allows read-only browser tools.';
const isBrowserTool = (tool: string) =>
  tool.startsWith(`mcp__${claudeBrowserServerName}__`);
const toolPresentation = {
  Read: { kind: 'read', title: 'Read file' },
  Glob: { kind: 'search', title: 'Find files' },
  Grep: { kind: 'search', title: 'Search files' },
  Edit: { kind: 'file-change', title: 'Edit file' },
  MultiEdit: { kind: 'file-change', title: 'Edit file' },
  Write: { kind: 'file-change', title: 'Write file' },
  NotebookEdit: { kind: 'file-change', title: 'Edit notebook' },
  Bash: { kind: 'command', title: 'Run command' },
  WebFetch: { kind: 'tool', title: 'Fetch URL' },
  TodoWrite: { kind: 'tool', title: 'Update plan' },
  Agent: { kind: 'tool', title: 'Run subagent' },
  Skill: { kind: 'tool', title: 'Use skill' },
  ExitPlanMode: { kind: 'tool', title: 'Present plan' },
} as const satisfies Record<
  string,
  { kind: ProviderActivity['kind']; title: string }
>;
const maxLineBytes = 1024 * 1024;
const maxTextBytes = 2_000_000;
const thinkingEmitIntervalMs = 250;
const probeTimeoutMs = 5_000;

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function textField(input: RecordValue | null, key: string): string {
  const value = input?.[key];
  return typeof value === 'string' ? value : '';
}

const todoMarks: Record<string, string> = {
  completed: '[x]',
  in_progress: '[>]',
};

function workToolDetail(
  name: 'TodoWrite' | 'Agent' | 'Skill',
  input: RecordValue | null,
): string | null {
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input?.todos) ? input.todos.map(object) : [];
    return (
      todos
        .map(todo => {
          const content = textField(todo, 'content');
          return content
            ? `${todoMarks[textField(todo, 'status')] ?? '[ ]'} ${content}`
            : '';
        })
        .filter(Boolean)
        .join('\n') || null
    );
  }
  if (name === 'Agent')
    return (
      [textField(input, 'subagent_type'), textField(input, 'description')]
        .filter(Boolean)
        .join(': ') || null
    );
  return (
    [textField(input, 'skill'), textField(input, 'args')]
      .filter(Boolean)
      .join(' ') || null
  );
}

function safeMessage(value: string): string {
  return value
    .replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .slice(0, 800);
}

function permissionChoices(help: string, flag = '--permission-mode'): string[] {
  const start = help.indexOf(flag);
  if (start < 0) return [];
  const rest = help.slice(start + flag.length);
  const end = rest.search(/\n {0,4}-/);
  const segment = end < 0 ? rest : rest.slice(0, end);
  const choices = /\(choices:([^)]*)\)/.exec(segment)?.[1] ?? '';
  return [...choices.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
}

function effortChoices(help: string): ClaudeStatus['efforts'] {
  const start = help.search(/(?:^|\s)--effort\s/);
  if (start < 0) return [];
  const rest = help.slice(start).replace(/^\s/, '');
  const end = rest.slice(1).search(/\n\s*-/);
  const segment = end < 0 ? rest : rest.slice(0, end + 1);
  const listed = /\(([a-z][a-z0-9_-]*(?:\s*,\s*[a-z][a-z0-9_-]*)*)\)/.exec(
    segment,
  )?.[1];
  if (!listed) return [];
  return [...new Set(listed.split(',').map(choice => choice.trim()))]
    .filter(choice => reasoningEffortSchema.safeParse(choice).success)
    .slice(0, 16)
    .map(id => ({ id, description: `Claude Code ${id} effort` }));
}

function acceptsStreamInput(help: string): boolean {
  const start = help.indexOf('--input-format');
  if (start < 0) return false;
  const rest = help.slice(start);
  const end = rest.slice(1).search(/\n\s*--/);
  const segment = end < 0 ? rest : rest.slice(0, end + 1);
  return /\(choices:[^)]*"stream-json"/.test(segment);
}

function claudeUserContent(
  prompt: string,
  images: readonly ClaudeImage[],
): string | Record<string, unknown>[] {
  if (!images.length) return prompt;
  return interleave(prompt, images).map(part =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type:
            part.item.mediaType === 'application/pdf' ? 'document' : 'image',
          source: {
            type: 'base64',
            media_type: part.item.mediaType,
            data: part.item.data,
          },
        },
  );
}

export function claudePathRule(path: string): string {
  const posix = path.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(posix);
  const absolute = drive
    ? `/${drive[1]!.toLowerCase()}/${posix.slice(3)}`
    : posix;
  return `/${absolute.replace(/\/+$/, '')}/**`;
}

function claudeTurnInput(
  prompt: string,
  images: readonly ClaudeImage[],
): {
  format: 'text' | 'stream-json';
  payload: string;
  content: string | Record<string, unknown>[];
} {
  const content = claudeUserContent(prompt, images);
  if (typeof content === 'string')
    return { format: 'text', payload: prompt, content };
  const message = { type: 'user', message: { role: 'user', content } };
  return {
    format: 'stream-json',
    payload: JSON.stringify(message) + '\n',
    content,
  };
}

function claudeCompactInput(instructions: string | null) {
  const content = [
    {
      type: 'text',
      text: instructions ? `/compact ${instructions}` : '/compact',
    },
  ];
  return {
    format: 'stream-json' as const,
    payload:
      JSON.stringify({ type: 'user', message: { role: 'user', content } }) +
      '\n',
    content,
  };
}

function browserConnected(servers: unknown): boolean {
  if (!Array.isArray(servers)) return false;
  const server = servers
    .map(object)
    .find(entry => entry?.name === claudeBrowserServerName);
  return (
    !!server &&
    !['failed', 'needs-auth', 'disabled'].includes(String(server.status))
  );
}

function supportedModes(choices: string[]): ClaudeMode[] {
  return [
    'read-only',
    ...optionalModes.filter(mode => choices.includes(claudeModes[mode].cli)),
  ];
}

let lastReadyModes: ClaudeMode[] | null = null;
let lastReadyEfforts: string[] | null = null;

export function reportedClaudeModes(): SessionMode[] | null {
  return lastReadyModes ? [...lastReadyModes] : null;
}

export function reportedClaudeEfforts(): string[] | null {
  return lastReadyEfforts ? [...lastReadyEfforts] : null;
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

function toolPatch(result: RecordValue | null): string {
  if (!Array.isArray(result?.structuredPatch)) return '';
  const lines: string[] = [];
  let length = 0;
  for (const hunk of result.structuredPatch.map(object)) {
    if (
      !hunk ||
      !Array.isArray(hunk.lines) ||
      ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
        Number.isSafeInteger,
      )
    )
      continue;
    const header =
      '@@ -' +
      hunk.oldStart +
      ',' +
      hunk.oldLines +
      ' +' +
      hunk.newStart +
      ',' +
      hunk.newLines +
      ' @@';
    for (const line of [header, ...hunk.lines]) {
      if (typeof line !== 'string') continue;
      lines.push(line.slice(0, activityLimits.output + 1));
      length += line.length + 1;
      if (length > activityLimits.output)
        return lines.join('\n').slice(0, activityLimits.output + 1);
    }
  }
  return lines.join('\n');
}

function approvalTimeout(): number {
  const configured = Number(process.env.NESVO_TEST_CLAUDE_APPROVAL_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 100
    ? Math.min(configured, claudeApprovalTimeoutMs)
    : claudeApprovalTimeoutMs;
}

function isClaudeMode(mode: SessionMode): mode is ClaudeMode {
  return mode in claudeModes;
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
      ...providerEnvironment(environment),
      ...(executable.prefix.length > 0 ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  recordProviderProcess(child.pid, environment);
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
  const tree = trackProcessTree(child, {
    hasExited: () => hasExited,
    hasClosed: () => hasClosed,
    checkWindowsExitCodes: true,
  });
  function stop(): Promise<void> {
    cleanup ??= (async () => {
      await tree.terminate(closed);
      if (!hasClosed) {
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await Promise.race([closed, wait(terminateGraceMs)]);
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
    tree.stopTracking();
    void stop();
  });
  child.once('close', code => {
    hasClosed = true;
    tree.stopTracking();
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
  environment?: Readonly<Record<string, string>>,
) {
  if (cancelled()) throw new Error('Stopped.');
  const owned = ownProcess(executable, args, undefined, environment);
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

async function inspect(
  cancelled: () => boolean,
  environment?: Readonly<Record<string, string>>,
): Promise<{
  status: ClaudeStatus;
  executable: Executable | null;
  permissionModes: string[];
  supportsFork?: boolean;
  supportsHostPrompts?: boolean;
  supportsStreamInput?: boolean;
  supportsAddDirectory?: boolean;
}> {
  let version: string | null = null;
  let permissionModes: string[] = [];
  let imageInput = false;
  let efforts: ClaudeStatus['efforts'] = [];
  let browserFlag = false;
  let browserExtension = false;
  const browser = (state: ClaudeStatus['status']): ClaudeStatus['browser'] =>
    state !== 'ready'
      ? {
          status: 'unsupported',
          reason: 'Claude Code is not ready on this computer.',
        }
      : !browserFlag
        ? {
            status: 'unsupported',
            reason:
              'This Claude Code version cannot use the browser. Update the CLI to use the browser.',
          }
        : !browserExtension
          ? {
              status: 'unsupported',
              reason:
                'The Claude Code browser extension is not installed in Chrome on this computer. Install it, sign in, then refresh Claude Code status.',
            }
          : { status: 'supported' };
  const status = (
    state: ClaudeStatus['status'],
    detail: string | null,
  ): ClaudeStatus => ({
    status: state,
    version,
    detail,
    models: state === 'ready' ? models.map(model => ({ ...model })) : [],
    effort:
      state === 'ready' && efforts.length
        ? { status: 'per-model' }
        : {
            status: 'unsupported',
            reason:
              state === 'ready'
                ? 'This Claude Code version does not offer an effort setting. Update the CLI to choose an effort.'
                : 'Claude Code is not ready on this computer.',
          },
    efforts: state === 'ready' ? efforts.map(option => ({ ...option })) : [],
    modes: state === 'ready' ? supportedModes(permissionModes) : [],
    images:
      state === 'ready' && imageInput
        ? { status: 'supported' }
        : {
            status: 'unsupported',
            reason:
              state === 'ready'
                ? 'This Claude Code version cannot receive images. Update the CLI to attach images.'
                : 'Claude Code is not ready on this computer.',
          },
    browser: browser(state),
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
      probe(executable, ['--version'], cancelled, environment),
      probe(executable, ['--help'], cancelled, environment),
      probe(executable, ['auth', 'status', '--json'], cancelled, environment),
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
    imageInput = acceptsStreamInput(help.stdout);
    efforts = effortChoices(help.stdout);
    browserFlag = /(?:^|\s)--chrome(?:\s|$)/.test(help.stdout);
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
    browserExtension = browserFlag && (await claudeBrowserExtensionInstalled());
    const ready = status('ready', null);
    lastReadyModes = ready.modes.filter(isClaudeMode);
    lastReadyEfforts = ready.efforts.map(option => option.id);
    return {
      executable,
      status: ready,
      permissionModes,
      supportsFork: /(?:^|\s)--fork-session(?:\s|$)/.test(help.stdout),
      supportsStreamInput: imageInput,
      supportsAddDirectory:
        /(?:^|\s)--add-dir(?:\s|$)/.test(help.stdout) &&
        help.stdout.includes('--disallowedTools'),
      supportsHostPrompts:
        help.stdout.includes('--permission-prompt-tool') &&
        permissionChoices(help.stdout, '--permission-prompts').includes('host'),
    };
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

export async function inspectClaudeMcp(
  cwd: string,
  dataDirectory: string,
  servers: ConfigTable,
  signal: AbortSignal,
  environment?: Readonly<Record<string, string>>,
  reconnect?: string,
) {
  const executable = await executablePath();
  if (!executable) throw new Error('Claude Code is unavailable.');
  signal.throwIfAborted();
  const config = await writeClaudeRunConfig(dataDirectory, servers, {
    disableAllHooks: true,
  });
  try {
    signal.throwIfAborted();
    const running = ownProcess(
      executable,
      [
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
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        config.mcpPath,
        '--settings',
        config.settingsPath,
      ],
      cwd,
      environment,
    );
    let pending:
      | {
          id: string;
          resolve(value: unknown): void;
          reject(error: Error): void;
        }
      | undefined;
    let bytes = 0;
    const fail = () => {
      pending?.reject(new Error('Claude MCP inspection stopped.'));
      void running.stop();
    };
    const detach = readFrames(
      running.child.stdout,
      maxLineBytes,
      value => {
        const frame = object(value);
        if (frame?.type === 'control_request') {
          fail();
          return;
        }
        const response =
          frame?.type === 'control_response' ? object(frame.response) : null;
        const current = pending;
        if (!response || !current || response.request_id !== current.id) return;
        if (response.subtype === 'success') current.resolve(response.response);
        else current.reject(new Error('Claude MCP operation is unavailable.'));
      },
      fail,
    );
    running.child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * maxLineBytes) fail();
    });
    running.child.stderr.resume();
    signal.addEventListener('abort', fail, { once: true });
    const timeout = setTimeout(fail, 12_000);
    const closed = running.closed.then(() => {
      throw new Error('Claude Code closed before returning MCP status.');
    });
    const request = (subtype: string, fields: RecordValue = {}) =>
      Promise.race([
        new Promise<unknown>((resolve, reject) => {
          signal.throwIfAborted();
          const id = randomUUID();
          pending = { id, resolve, reject };
          running.child.stdin.write(
            JSON.stringify({
              type: 'control_request',
              request_id: id,
              request: { subtype, ...fields },
            }) + '\n',
          );
        }),
        closed,
      ]);
    try {
      await request('initialize', { hooks: {}, sdkMcpServers: [] });
      const readStatus = async () => {
        const deadline = Date.now() + 3_000;
        while (true) {
          const status = object(await request('mcp_status'));
          const mapped = mcpStatusMap(status?.mcpServers, claudeMcpStatus);
          if (
            Date.now() >= deadline ||
            !Object.keys(servers).some(
              name => !mapped.has(name) || mapped.get(name)?.waiting,
            )
          )
            return mapped;
          await wait(250);
        }
      };
      const initial = await readStatus();
      if (!reconnect || initial.get(reconnect)?.status === 'connected')
        return initial;
      await request('mcp_reconnect', { serverName: reconnect });
      return await readStatus();
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', fail);
      detach();
      await running.stop();
    }
  } finally {
    await config.dispose();
  }
}

export async function runClaudeMcpAuth(
  cwd: string,
  action: NativeMcpAction,
  name: string,
  signal: AbortSignal,
  environment?: Readonly<Record<string, string>>,
) {
  const executable = await executablePath();
  if (!executable) return false;
  signal.throwIfAborted();
  return finishNativeMcpCommand(
    ownProcess(
      executable,
      ['mcp', action === 'authorize' ? 'login' : 'logout', name],
      cwd,
      environment,
    ),
    signal,
  );
}

export async function inspectClaude(
  signal?: AbortSignal,
  environment?: Readonly<Record<string, string>>,
): Promise<ClaudeStatus> {
  return (await inspect(() => signal?.aborted ?? false, environment)).status;
}

export async function inspectClaudeUsage(
  signal?: AbortSignal,
  environment?: Readonly<Record<string, string>>,
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
    owned = ownProcess(
      executable,
      [
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
        ...isolatedToolArgs,
      ],
      undefined,
      environment,
    );
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

export type ClaudeCommandReport = {
  commands: ClaudeCommand[];
  detail: string | null;
};

function reportedCommands(value: unknown): ClaudeCommand[] {
  const listed = object(value)?.commands;
  if (!Array.isArray(listed)) return [];
  const seen = new Set<string>();
  return listed
    .map(object)
    .flatMap(entry => {
      const name = textField(entry, 'name').trim();
      if (!name || name.length > claudeCommandLimits.name || seen.has(name))
        return [];
      seen.add(name);
      return [
        {
          name,
          description: textField(entry, 'description').slice(
            0,
            claudeCommandLimits.description,
          ),
          argumentHint:
            textField(entry, 'argumentHint').slice(
              0,
              claudeCommandLimits.argumentHint,
            ) || null,
        },
      ];
    })
    .slice(0, claudeCommandLimits.entries);
}

export async function inspectClaudeCommands(options: {
  directory: string;
  projectSettings: boolean;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string>>;
}): Promise<ClaudeCommandReport> {
  const unavailable = (detail: string): ClaudeCommandReport => ({
    commands: [],
    detail,
  });
  if (options.signal?.aborted) return unavailable('Stopped.');
  const executable = await executablePath().catch(() => null);
  if (!executable)
    return unavailable('Install Claude Code to list its commands.');
  const owned = ownProcess(
    executable,
    [
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
      ...isolatedToolArgs,
      '--setting-sources',
      options.projectSettings ? 'user,project,local' : 'user',
    ],
    options.directory,
    options.environment,
  );
  const requestId = randomUUID();
  let detach: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const answer = new Promise<ClaudeCommandReport>(resolve => {
      const finish = (report: ClaudeCommandReport) => {
        resolve(report);
        void owned.stop();
      };
      detach = readFrames(
        owned.child.stdout,
        4 * maxLineBytes,
        value => {
          const frame = object(value);
          if (frame?.type === 'control_request')
            return finish(
              unavailable(
                'Claude Code requested an operation while listing commands.',
              ),
            );
          const response = object(frame?.response);
          if (
            frame?.type !== 'control_response' ||
            response?.request_id !== requestId
          )
            return;
          finish(
            response.subtype === 'success'
              ? {
                  commands: reportedCommands(response.response),
                  detail: null,
                }
              : unavailable(
                  'This Claude Code version did not list its commands. Update the CLI.',
                ),
          );
        },
        () => finish(unavailable('Claude Code returned an invalid frame.')),
      );
      owned.child.stderr.resume();
      abort = () => finish(unavailable('Stopped.'));
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(
        () =>
          finish(unavailable('Claude Code did not list its commands in time.')),
        15_000,
      );
      void owned.closed.then(() =>
        finish(unavailable('Claude Code closed before listing its commands.')),
      );
      owned.child.stdin.write(
        JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] },
        }) + '\n',
      );
    });
    return await answer;
  } catch {
    return unavailable('Claude Code commands could not be listed.');
  } finally {
    clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
    detach?.();
    owned.child.stdin.end();
    await owned.stop();
  }
}

export async function confirmClaudeFork(
  mode: SessionMode,
  signal: AbortSignal,
  environment?: Readonly<Record<string, string>>,
): Promise<void> {
  const inspection = await inspect(() => signal.aborted, environment);
  if (signal.aborted) throw new Error('Claude Code fork inspection stopped.');
  if (inspection.status.status !== 'ready')
    throw new Error(inspection.status.detail ?? 'Claude Code is unavailable.');
  if (!inspection.supportsFork)
    throw new Error(
      'This Claude Code version does not support native session forking.',
    );
  if (!inspection.status.modes.includes(mode))
    throw new Error(
      'Claude Code does not offer the source session permission mode.',
    );
}

export async function claudeSupportsHostPrompts(
  signal: AbortSignal,
  environment?: Readonly<Record<string, string>>,
): Promise<boolean> {
  const inspection = await inspect(() => signal.aborted, environment);
  return inspection.supportsHostPrompts === true;
}

export function startClaude(options: {
  directory: string;
  sessionId: string;
  resume: boolean;
  forkFrom?: string;
  model: string;
  effort?: string | null;
  prompt: string;
  environment?: Readonly<Record<string, string>>;
  outputSchema?: Record<string, unknown>;
  ephemeral?: boolean;
  instructionsOnly?: boolean;
  isolatedContext?: boolean;
  assistantPrompt?: string;
  summaryInstructions?: string;
  mode: SessionMode;
  images?: readonly ClaudeImage[];
  readDirectories?: readonly string[];
  approvals?: boolean;
  assertFullAccess?: () => void;
  permissionRules?: { allows: (candidate: AllowCandidate) => boolean };
  mcpTurn?: { verify: VerifyMcpTurn; dataDirectory: string };
  compact?: { instructions: string | null };
  control?: SessionControlTurn;
  planTurn?: boolean;
  questions?: boolean;
  browser?: boolean;
  gate?: TurnGate;
  onEvent: (event: ClaudeEvent) => void;
}): {
  done: Promise<ClaudeResult>;
  stop: () => Promise<void>;
  respondApproval: (
    requestId: string,
    decision: 'accept' | 'decline',
    message?: string,
  ) => void;
} {
  let stopped = false;
  let owned: OwnedProcess | null = null;
  let respond: ReturnType<typeof startClaude>['respondApproval'] | null = null;
  let releaseApprovals: (() => void) | null = null;
  const done = (async (): Promise<ClaudeResult> => {
    let failure: string | null = null;
    let runConfig: Awaited<ReturnType<typeof writeClaudeRunConfig>> | undefined;
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
      const inspection = await inspect(() => stopped, options.environment);
      if (stopped) return { status: 'stopped', error: null };
      if (inspection.status.status !== 'ready' || !inspection.executable)
        throw new Error(
          inspection.status.detail ?? 'Claude Code is unavailable.',
        );
      if (!inspection.status.modes.includes(options.mode))
        return {
          status: 'failed',
          error:
            'This Claude Code version does not offer the selected permission mode. Update the CLI or choose Plan.',
          modeUnavailable: true,
        };
      if (
        options.effort &&
        !inspection.status.efforts.some(option => option.id === options.effort)
      )
        return {
          status: 'failed',
          error: `This Claude Code version does not offer the ${options.effort} effort. Update the CLI or choose another effort.`,
          effortUnavailable: true,
        };
      if (
        options.images?.length &&
        inspection.status.images.status !== 'supported'
      )
        return {
          status: 'failed',
          error:
            'This Claude Code version cannot receive images or PDF files. Update the CLI or send the message without them.',
        };
      if (options.browser && inspection.status.browser.status !== 'supported')
        return {
          status: 'failed',
          error: `${inspection.status.browser.reason} No provider turn was started.`,
        };
      if (options.readDirectories?.length && !inspection.supportsAddDirectory)
        return {
          status: 'failed',
          error:
            'This Claude Code version cannot read attached files. Update the CLI or send the message without files.',
        };
      if (
        options.compact &&
        (!options.resume || !inspection.supportsStreamInput)
      )
        return {
          status: 'failed',
          error: options.resume
            ? 'This Claude Code version cannot compact the conversation from Nesvo. Update the CLI.'
            : 'There is no Claude Code conversation to compact yet.',
        };
      const input = options.compact
        ? claudeCompactInput(options.compact.instructions)
        : claudeTurnInput(options.prompt, options.images ?? []);
      if (options.forkFrom && !inspection.supportsFork)
        throw new Error(
          'This Claude Code version does not support native session forking.',
        );
      const permission = claudeModes[options.mode];
      const presentsPlan =
        options.planTurn === true &&
        options.mode === 'read-only' &&
        options.approvals === true &&
        inspection.supportsHostPrompts === true;
      const assistantMode = ['dontAsk', 'default'].find(candidate =>
        inspection.permissionModes.includes(candidate),
      );
      const permissionMode =
        options.assistantPrompt && options.mode === 'read-only' && assistantMode
          ? assistantMode
          : permission.cli;
      const readOnly = options.mode === 'read-only';
      const integrations = await options.mcpTurn?.verify();
      const configured = integrations
        ? { ...integrations.servers, ...integrations.projectServers }
        : {};
      const servers = options.control
        ? withoutControlServer(configured)
        : configured;
      const canAsk =
        options.approvals === true &&
        !options.compact &&
        !options.assistantPrompt &&
        !options.outputSchema &&
        inspection.supportsHostPrompts === true;
      const gate = options.gate;
      if (gate?.askRules.length && !canAsk && !readOnly) {
        if (gate.withoutHostPrompts.refusal)
          return { status: 'failed', error: gate.withoutHostPrompts.refusal };
      }
      const promptWarning =
        gate?.askRules.length && !canAsk && !readOnly
          ? gate.withoutHostPrompts.warning
          : null;
      const canAskQuestion = canAsk && options.questions === true;
      let askedQuestion = false;
      const webFetch = !!options.permissionRules && canAsk && !readOnly;
      const textOnly =
        !!options.summaryInstructions || !!options.isolatedContext;
      const tools = textOnly
        ? ''
        : [
            ...permission.tools,
            ...(presentsPlan ? [EXIT_PLAN_TOOL] : []),
            ...(canAskQuestion ? [QUESTION_TOOL] : []),
            ...(webFetch ? ['WebFetch'] : []),
          ].join(',');
      const askRules =
        !readOnly && canAsk
          ? [
              ...new Set([
                ...(gate?.askRules ?? []),
                ...(webFetch ? ['WebFetch'] : []),
              ]),
            ]
          : [];
      const controlled = !!options.control && canAsk;
      const hostPrompts =
        canAsk &&
        (!readOnly ||
          Object.keys(servers).length > 0 ||
          controlled ||
          presentsPlan ||
          canAskQuestion ||
          !!options.browser);
      const allowedTools = textOnly
        ? ''
        : [
            ...permission.allowed,
            ...(options.browser && (!hostPrompts || presentsPlan)
              ? unattendedBrowserTools
              : []),
          ].join(',');
      if (integrations && options.mcpTurn)
        runConfig = await writeClaudeRunConfig(
          options.mcpTurn.dataDirectory,
          !readOnly || canAsk ? servers : {},
          {
            ...(readOnly || integrations.projectDisablesHooks
              ? { disableAllHooks: true }
              : integrations.projectSettings
                ? {}
                : { hooks: integrations.projectHooks }),
            ...(readOnly
              ? { permissions: { ask: ['mcp__*'] } }
              : askRules.length
                ? { permissions: { ask: askRules } }
                : {}),
          },
        );
      const mcpArgs = runConfig
        ? [
            '--strict-mcp-config',
            '--mcp-config',
            runConfig.mcpPath,
            '--settings',
            runConfig.settingsPath,
            '--setting-sources',
            integrations?.projectSettings ? 'user,project,local' : 'user',
          ]
        : [
            ...(textOnly || askRules.length
              ? [
                  ...isolatedMcpArgs,
                  '--settings',
                  JSON.stringify({
                    disableAllHooks: true,
                    ...(textOnly
                      ? { autoMemoryEnabled: false, claudeMdExcludes: ['**'] }
                      : {}),
                    ...(askRules.length
                      ? { permissions: { ask: askRules } }
                      : {}),
                  }),
                ]
              : isolatedToolArgs),
            '--setting-sources',
            options.instructionsOnly || options.isolatedContext ? '' : 'user',
          ];
      if (stopped) return { status: 'stopped', error: null };
      const args = [
        '--print',
        '--input-format',
        hostPrompts || input.format === 'stream-json' ? 'stream-json' : 'text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        permissionMode,
        '--permission-prompts',
        ...(hostPrompts
          ? ['host', '--permission-prompt-tool', 'stdio']
          : ['none']),
        '--tools',
        tools,
        '--allowedTools',
        allowedTools,
        ...mcpArgs,
        options.resume ? '--resume' : '--session-id',
        options.sessionId,
        ...(options.forkFrom
          ? ['--resume', options.forkFrom, '--fork-session']
          : []),
      ];
      if (options.readDirectories?.length)
        args.push(
          '--add-dir',
          ...options.readDirectories,
          '--disallowedTools',
          options.readDirectories
            .map(directory => `Edit(${claudePathRule(directory)})`)
            .join(','),
        );
      if (options.model !== 'default') args.push('--model', options.model);
      if (options.effort) args.push('--effort', options.effort);
      if (options.browser) args.push('--chrome');
      if (options.ephemeral) args.push('--no-session-persistence');
      const systemInstructions =
        options.summaryInstructions ?? options.assistantPrompt;
      if (systemInstructions)
        args.push('--append-system-prompt', systemInstructions);
      if (options.outputSchema)
        args.push('--json-schema', JSON.stringify(options.outputSchema));
      if (stopped) return { status: 'stopped', error: null };
      if (options.mode === 'full-access') {
        if (!options.assertFullAccess)
          throw new Error('Full access requires session confirmation.');
        options.assertFullAccess();
      }
      owned = ownProcess(
        inspection.executable,
        args,
        options.directory,
        options.permissionRules
          ? {
              ...options.environment,
              CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
            }
          : options.environment,
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
      let context: ContextFill | null = null;
      let reportedModel: string | null = null;
      let compactedTokens: { post: number | null } | null = null;
      const structured: { output?: { value: unknown } } = {};
      let successful = false;
      let initialized = false;
      let providerFailure: string | null = null;
      let rateLimitFailure: string | null = null;
      let rateLimitResetsAt: string | null = null;
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
      const approvals = new Map<
        string,
        {
          input: Record<string, unknown>;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      const writeFrame = (frame: Record<string, unknown>) => {
        if (!running.child.stdin.writable)
          throw new Error('Claude Code closed its input.');
        running.child.stdin.write(JSON.stringify(frame) + '\n');
      };
      const control =
        controlled && options.control
          ? createClaudeControlChannel({
              tools: options.control.tools,
              call: options.control.call,
              write: writeFrame,
              onFailure: fail,
            })
          : null;
      const controlUnavailable = () =>
        emit({
          type: 'tool-activity',
          activity: makeActivity({
            id: 'session-control-unavailable',
            kind: 'tool',
            title: 'Session control unavailable',
            status: 'failed',
            detail:
              'This Claude Code version did not connect the Nesvo tools, so this turn cannot create or steer sessions.',
          }),
        });
      if (options.control && !control) controlUnavailable();
      if (promptWarning)
        emit({
          type: 'tool-activity',
          activity: makeActivity({
            id: 'inbox-rule-prompts-unavailable',
            kind: 'tool',
            title: 'Inbox rule cannot hold here',
            status: 'failed',
            detail: promptWarning,
          }),
        });
      const controlToolNames = options.control
        ? claudeControlToolNames(options.control.tools)
        : new Set<string>();
      const settleApproval = (id: string) => {
        const pending = approvals.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        approvals.delete(id);
        emit({ type: 'approval-resolved', id });
      };
      const answerApproval = (
        id: string,
        answer: Parameters<typeof claudePermissionAnswer>[1],
      ) => {
        writeFrame(claudePermissionAnswer(id, answer));
        settleApproval(id);
      };
      const deny = (id: string, message: string) => {
        try {
          writeFrame(claudePermissionAnswer(id, { behavior: 'deny', message }));
        } catch {
          fail('Claude permission answer could not be delivered.');
        }
      };
      releaseApprovals = () => {
        for (const pending of approvals.values()) clearTimeout(pending.timer);
        approvals.clear();
        control?.close();
      };
      respond = (id, decision, message) => {
        const pending = approvals.get(id);
        if (stopped || failure || !pending)
          throw new Error(
            'Claude approval is no longer pending for this turn.',
          );
        try {
          answerApproval(
            id,
            decision === 'accept'
              ? { behavior: 'allow', input: pending.input }
              : {
                  behavior: 'deny',
                  message: message
                    ? `The operator denied this action. Their message: ${message}`
                    : 'The operator denied this action.',
                },
          );
        } catch (error) {
          fail('Claude permission answer could not be delivered.');
          throw error;
        }
      };
      const permissionRequest = (value: RecordValue) => {
        if (!hostPrompts) return;
        if (control && isClaudeMcpMessage(value)) {
          control.handle(value);
          return;
        }
        const request = object(value.request);
        if (request?.subtype !== 'can_use_tool') {
          if (typeof value.request_id === 'string')
            try {
              writeFrame(
                claudeControlError(
                  value.request_id,
                  'Nesvo does not support this request.',
                ),
              );
            } catch {
              fail('Claude control answer could not be delivered.');
            }
          return;
        }
        if (
          request.tool_name === QUESTION_TOOL &&
          typeof value.request_id === 'string' &&
          value.request_id.length <= 200
        ) {
          const questions =
            canAskQuestion && !askedQuestion
              ? providerQuestion(object(request.input)?.questions)
              : undefined;
          if (questions) {
            askedQuestion = true;
            emit({ type: 'question', questions });
          }
          deny(
            value.request_id,
            questions
              ? 'Nesvo saved your question for the operator. End this turn now and wait for their next message.'
              : 'This question could not be recorded. Use a closing question in your response if you still need an answer.',
          );
          return;
        }
        const parsed = parseClaudePermissionRequest(value, options.directory);
        if (parsed.status === 'invalid') {
          if (parsed.requestId)
            deny(
              parsed.requestId,
              'Nesvo could not read this permission request, so it was denied.',
            );
          else fail('Claude returned an invalid permission request.');
          return;
        }
        if (parsed.status === 'unreviewable') {
          deny(
            parsed.requestId,
            'This request is too large to review in Nesvo, so it was denied.',
          );
          return;
        }
        const { request: ask } = parsed;
        if (control && controlToolNames.has(String(request.tool_name))) {
          try {
            writeFrame(
              claudePermissionAnswer(ask.requestId, {
                behavior: 'allow',
                input: ask.input,
              }),
            );
          } catch {
            fail('Claude permission answer could not be delivered.');
          }
          return;
        }
        if (presentsPlan && request.tool_name === EXIT_PLAN_TOOL) {
          const plan = ask.input.plan;
          if (typeof plan === 'string' && plan.trim())
            emit({ type: 'plan', text: plan });
          deny(ask.requestId, PLAN_RECEIVED_MESSAGE);
          return;
        }
        if (
          options.planTurn &&
          isBrowserTool(String(request.tool_name)) &&
          !unattendedBrowserTools.includes(String(request.tool_name))
        ) {
          deny(ask.requestId, PLAN_BROWSER_MESSAGE);
          return;
        }
        if (readOnly && !String(request.tool_name).startsWith('mcp__')) {
          deny(ask.requestId, 'Plan mode only asks for MCP tool approvals.');
          return;
        }
        if (approvals.has(ask.requestId)) {
          fail('Claude repeated a permission request.');
          return;
        }
        const subject = {
          tool: String(request.tool_name),
          input: ask.input,
        };
        if (gate?.holds(subject)) {
          approvals.set(ask.requestId, {
            input: ask.input,
            timer: setTimeout(() => undefined, 0),
          });
          emit({ type: 'approval', approval: ask.approval, subject });
          return;
        }
        const recheckRule = options.permissionRules
          ? () =>
              claudeAllowCandidate(
                options.directory,
                String(request.tool_name),
                ask.input,
                servers,
                request.blocked_path,
              )
          : undefined;
        const eligibility = recheckRule?.();
        const candidate =
          eligibility && 'kind' in eligibility ? eligibility : undefined;
        if (candidate && options.permissionRules?.allows(candidate)) {
          try {
            writeFrame(
              claudePermissionAnswer(ask.requestId, {
                behavior: 'allow',
                input: ask.input,
              }),
            );
          } catch {
            fail('Claude permission answer could not be delivered.');
          }
          return;
        }
        const timer = setTimeout(() => {
          if (!approvals.has(ask.requestId)) return;
          try {
            answerApproval(ask.requestId, {
              behavior: 'deny',
              message:
                'Nobody answered this permission request in time, so it was denied.',
            });
          } catch {
            fail('Claude permission answer could not be delivered.');
          }
        }, approvalTimeout());
        approvals.set(ask.requestId, { input: ask.input, timer });
        emit({
          type: 'approval',
          approval:
            eligibility && 'reason' in eligibility
              ? { ...ask.approval, allowRuleReason: eligibility.reason }
              : ask.approval,
          subject,
          ...(candidate ? { candidate, recheckRule } : {}),
        });
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
      const controlActivity = (block: RecordValue, tool: string) => {
        const title = sessionControlToolTitle(tool);
        emit({ type: 'activity', text: title });
        if (typeof block.id !== 'string') return;
        const previous = toolActivities.get(block.id);
        const input = object(block.input);
        const next = makeActivity({
          id: block.id,
          kind: 'tool',
          title,
          status: previous?.status ?? 'running',
          startedAt: previous?.startedAt,
          completedAt: previous?.completedAt,
          detail:
            typeof input?.title === 'string'
              ? input.title
              : (previous?.detail ?? null),
          output: previous?.output,
          truncated: previous?.truncated,
        });
        toolActivities.set(next.id, next);
        emit({ type: 'tool-activity', activity: next });
      };
      const mcpActivity = (block: RecordValue) => {
        const name = String(block.name);
        const [server = '', ...tool] = name.slice('mcp__'.length).split('__');
        if (server === SESSION_CONTROL_NAMESPACE && control)
          return controlActivity(block, tool.join('__'));
        emit({ type: 'activity', text: 'MCP tool' });
        if (typeof block.id !== 'string') return;
        const previous = toolActivities.get(block.id);
        const next = makeActivity({
          id: block.id,
          kind: 'tool',
          title: 'Use MCP tool',
          status: previous?.status ?? 'running',
          startedAt: previous?.startedAt,
          completedAt: previous?.completedAt,
          detail: [server, tool.join('__')].filter(Boolean).join(' / ') || null,
          output: previous?.output,
          truncated: previous?.truncated,
        });
        toolActivities.set(next.id, next);
        emit({ type: 'tool-activity', activity: next });
      };
      const activity = (block: RecordValue | null) => {
        if (
          block?.type === 'tool_use' &&
          typeof block.name === 'string' &&
          block.name.startsWith('mcp__')
        )
          return mcpActivity(block);
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
            name === 'TodoWrite' || name === 'Agent' || name === 'Skill'
              ? workToolDetail(name, input)
              : name === 'Bash'
                ? command
                : name === 'WebFetch' && typeof input?.url === 'string'
                  ? input.url
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
        if (value.type === 'control_request') return permissionRequest(value);
        if (value.type === 'control_cancel_request') {
          if (
            typeof value.request_id === 'string' &&
            !control?.cancel(value.request_id)
          )
            settleApproval(value.request_id);
          return;
        }
        if (value.type === 'control_response') return;
        if (value.parent_tool_use_id) return;
        if (value.type === 'system' && value.subtype === 'init') {
          if (
            typeof value.session_id !== 'string' ||
            typeof value.model !== 'string' ||
            (options.forkFrom && value.session_id !== options.sessionId)
          ) {
            fail('Claude returned invalid session metadata.');
          } else {
            initialized = true;
            reportedModel = value.model;
            if (control && !isClaudeControlServer(value.mcp_servers))
              controlUnavailable();
            if (options.browser && !browserConnected(value.mcp_servers)) {
              fail(
                'The Claude Code browser extension did not connect. Open Chrome with the extension signed in, then send the message again.',
              );
              return;
            }
            emit({
              type: 'init',
              sessionId: value.session_id,
              model: value.model,
            });
          }
        } else if (
          value.type === 'system' &&
          value.subtype === 'compact_boundary'
        ) {
          const post = object(value.compact_metadata)?.post_tokens;
          compactedTokens = {
            post:
              typeof post === 'number' &&
              Number.isSafeInteger(post) &&
              post >= 0
                ? post
                : null,
          };
        } else if (
          value.type === 'system' &&
          value.subtype === 'status' &&
          value.status === 'compacting'
        ) {
          emit({ type: 'activity', text: 'Compacting conversation…' });
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
          const result =
            message.content.length === 1 ? object(value.tool_use_result) : null;
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
                previous.kind === 'command'
                  ? [textField(result, 'stdout'), textField(result, 'stderr')]
                      .filter(Boolean)
                      .join('\n') || toolResultText(block.content)
                  : (previous.kind === 'file-change' && toolPatch(result)) ||
                    (failed ? toolResultText(block.content) : ''),
            });
            toolActivities.set(next.id, next);
            emit({ type: 'tool-activity', activity: next });
          }
        } else if (value.type === 'result') {
          resultSeen = true;
          if (hostPrompts) {
            for (const id of [...approvals.keys()]) settleApproval(id);
            running.child.stdin.end();
          }
          usage = claudeTurnUsage(value);
          context = claudeContextFill(
            value,
            reportedModel,
            compactedTokens?.post ?? null,
          );
          successful = value.is_error === false && value.subtype === 'success';
          if (options.outputSchema && 'structured_output' in value)
            structured.output = { value: value.structured_output };
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
            !options.compact &&
            !lastText &&
            !providerFailure &&
            !rateLimitFailure
          ) {
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
          providerFailure = safeMessage(
            typeof error?.message === 'string'
              ? error.message
              : 'Claude could not continue. Check account limits and authentication.',
          );
        }
      };
      const inactivityLimit = providerInactivityLimit();
      const watchdog = watchInactivity({
        limitMs: inactivityLimit,
        isWaiting: () => approvals.size > 0 || (control?.pending() ?? 0) > 0,
        onInactive: () => fail(inactivityFailure('Claude', inactivityLimit)),
      });
      running.child.stdout.setEncoding('utf8');
      running.child.stderr.setEncoding('utf8');
      running.child.stdout.on('data', (chunk: string) => {
        if (failure || stopped) return;
        watchdog.touch();
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxTurnOutputBytes) {
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
      if (hostPrompts) {
        try {
          writeFrame({
            type: 'control_request',
            request_id: randomUUID(),
            request: {
              subtype: 'initialize',
              hooks: {},
              ...(control && options.control
                ? claudeControlInitialize(options.control.tools)
                : { sdkMcpServers: [] }),
            },
          });
          writeFrame({
            type: 'user',
            message: { role: 'user', content: input.content },
            parent_tool_use_id: null,
          });
        } catch {
          fail('Claude Code did not accept the prompt.');
        }
      } else running.child.stdin.end(input.payload);
      let exit: ProcessExit;
      try {
        exit = await running.closed;
        if (line) consume(line);
      } finally {
        watchdog.stop();
        releaseApprovals();
        await running.stop();
      }
      const reported = {
        ...(usage ? { usage } : {}),
        ...(context ? { context } : {}),
        ...(structured.output ? { structured: structured.output.value } : {}),
      };
      if (failure) return { status: 'failed', error: failure };
      if (!exit.confirmed)
        return {
          status: 'failed',
          error: 'Claude process closure could not be confirmed after cleanup.',
        };
      if (providerFailure || rateLimitFailure)
        return {
          status: 'failed',
          error: providerFailure ?? rateLimitFailure,
          ...reported,
          ...(rateLimitFailure
            ? { limit: { resetsAt: rateLimitResetsAt } }
            : {}),
        };
      if (!stopped && resultSeen && successful && askedQuestion)
        return { status: 'completed', error: null, ...reported };
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
      if (options.compact) {
        if (!compactedTokens)
          throw new Error('Claude Code did not compact the conversation.');
        return {
          status: 'completed',
          error: null,
          compacted: true,
          ...reported,
        };
      }
      if (!lastText)
        throw new Error('Claude Code completed without an assistant response.');
      return { status: 'completed', error: null, ...reported };
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
    } finally {
      await runConfig?.dispose();
    }
  })();
  return {
    done,
    stop: async () => {
      stopped = true;
      releaseApprovals?.();
      await owned?.stop();
      await done;
    },
    respondApproval: (requestId, decision, message) => {
      if (!respond)
        throw new Error('Claude approval is no longer pending for this turn.');
      respond(requestId, decision, message);
    },
  };
}
