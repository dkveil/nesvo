import {
  parseDurationMs,
  pipelineLimits,
  stepResultLimits,
  type Evidence,
  type StepResult,
} from '@nesvo/contracts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterResultText } from '../evidence';
import type { StepExecution, StepExecutor, StepOutcome } from '../runner';
import {
  OwnedProcessError,
  TailBuffer,
  runOwnedProcess,
  type OwnedProcessResult,
} from './process';

export const SECRET_VARIABLE = /(^|_)(KEY|TOKEN|SECRET|PASSWORD)$/i;
export const STEP_OUTPUT_BYTES = pipelineLimits.evidenceBytesPerStep;

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const SUMMARY_TAIL_CHARS = 2_000;

export type ShellRun = {
  process: OwnedProcessResult | null;
  failure: string | null;
  log: string;
  secrets: string[];
  evidence: Evidence[];
  finishedAt: string;
};

const envName = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export function stepEnvironment(execution: StepExecution): {
  env: NodeJS.ProcessEnv;
  secrets: string[];
} {
  const inherited = execution.environment;
  const allowed = new Set(
    execution.definition.needs
      .filter(need => need.startsWith('env:'))
      .map(need => need.slice('env:'.length)),
  );
  const env: NodeJS.ProcessEnv = {};
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(inherited)) {
    if (value == null) continue;
    const listed = allowed.has(name);
    if (!listed && name.startsWith('NESVO_')) continue;
    if (SECRET_VARIABLE.test(name)) {
      if (!listed) continue;
      secrets.push(value);
    }
    env[name] = value;
  }
  for (const [step, outputs] of execution.outputs)
    for (const [key, value] of Object.entries(outputs)) {
      const name = `NESVO_OUTPUT_${envName(step)}_${envName(key)}`;
      env[name] ??= filterResultText(value, secrets);
    }
  return {
    env: {
      ...env,
      NESVO_RUN_ID: execution.run.id,
      NESVO_STEP_NAME: execution.step.name,
      NESVO_PHASE: execution.step.phase,
      NESVO_SPEC_PATH: execution.run.specPath,
      NESVO_PROJECT_ROOT: execution.run.projectRoot,
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    secrets,
  };
}

type StepShell = {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  dispose: () => Promise<void>;
};

const windowsScript = (body: string) =>
  ['@echo off', 'chcp 65001 >nul', ...body.split(/\r?\n/), ''].join('\r\n');

const prepareShell = async (body: string): Promise<StepShell> => {
  if (process.platform !== 'win32')
    return {
      command: '/bin/sh',
      args: ['-c', body],
      windowsVerbatimArguments: false,
      dispose: () => Promise.resolve(),
    };
  const directory = await mkdtemp(join(tmpdir(), 'nesvo-step-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  const script = join(directory, 'step.cmd');
  try {
    await writeFile(script, windowsScript(body), { mode: 0o600 });
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `""${script}""`],
    windowsVerbatimArguments: true,
    dispose,
  };
};

export async function runShellStep(
  execution: StepExecution,
): Promise<ShellRun | null> {
  const { env, secrets } = stepEnvironment(execution);
  const combined = new TailBuffer(STEP_OUTPUT_BYTES);
  let result: OwnedProcessResult | null = null;
  let failure: string | null = null;
  let recording: Promise<void> = Promise.resolve();
  let shell: StepShell | null = null;
  try {
    shell = await prepareShell(execution.definition.body);
    result = await runOwnedProcess({
      command: shell.command,
      args: shell.args,
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
      cwd: execution.run.directory,
      env,
      timeoutMs:
        parseDurationMs(execution.definition.timeout) ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: STEP_OUTPUT_BYTES,
      signal: execution.signal,
      onSpawn: pid => {
        recording = execution.evidence
          .recordProcess(execution.step, pid)
          .catch(() => undefined);
      },
      onStdout: chunk => combined.push(chunk),
      onStderr: chunk => combined.push(chunk),
    });
  } catch (error) {
    if (!execution.signal.aborted)
      failure =
        error instanceof OwnedProcessError
          ? error.message
          : 'The command could not start.';
  } finally {
    await recording;
    await execution.evidence.clearProcess(execution.step).catch(() => undefined);
    await shell?.dispose().catch(() => undefined);
  }
  if (execution.signal.aborted) return null;
  const log = filterResultText(combined.text(), secrets);
  const file = `attempt-${execution.step.attempt}.log`;
  await execution.evidence.write(execution.step, file, log);
  return {
    process: result,
    failure: failure ? filterResultText(failure, secrets) : null,
    log,
    secrets,
    evidence: [{ kind: 'log', label: 'Output', path: file, text: null, url: null }],
    finishedAt: execution.now().toISOString(),
  };
}

export function outcomeSummary(
  run: ShellRun,
  timeout: string,
  extra: string[] = [],
): string {
  const head = run.failure
    ? run.failure
    : run.process?.timedOut
      ? `Timed out after ${timeout}; the process was stopped.`
      : run.process?.code != null
        ? `Exit code ${run.process.code}.`
        : `Ended by signal ${run.process?.signal ?? 'unknown'}.`;
  const tail = run.log.trimEnd().slice(-SUMMARY_TAIL_CHARS).trim();
  const summary = [head, ...extra, ...(tail ? [`Last output:\n${tail}`] : [])].join(
    '\n\n',
  );
  return summary.length > stepResultLimits.summary
    ? summary.slice(0, stepResultLimits.summary)
    : summary;
}

export const succeeded = (run: ShellRun) =>
  !run.failure && !run.process?.timedOut && run.process?.code === 0;

export function shellResult(
  execution: StepExecution,
  run: ShellRun,
  status: StepResult['status'],
  summary: string,
  outputs: Record<string, string> = {},
): StepResult {
  const startedAt = execution.step.startedAt ?? run.finishedAt;
  return {
    name: execution.step.name,
    type: execution.step.type,
    phase: execution.step.phase,
    status,
    summary,
    evidence: run.evidence,
    outputs,
    startedAt,
    finishedAt: run.finishedAt,
    durationMs: Math.max(0, Date.parse(run.finishedAt) - Date.parse(startedAt)),
    cost: { usd: null, inputTokens: null, outputTokens: null, provider: null },
    attempt: Math.max(execution.step.attempt, 1),
  };
}

export const commandExecutor: StepExecutor = async (
  execution,
): Promise<StepOutcome> => {
  const run = await runShellStep(execution);
  if (!run) return { kind: 'interrupted' };
  return {
    kind: 'result',
    result: shellResult(
      execution,
      run,
      succeeded(run) ? 'pass' : 'fail',
      outcomeSummary(run, execution.definition.timeout),
    ),
  };
};
