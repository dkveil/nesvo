import { STEP_OUTPUT_KEY_PATTERN, stepResultLimits } from '@nesvo/contracts';
import { filterResultText } from '../evidence';
import type { StepExecutor, StepOutcome } from '../runner';
import { outcomeSummary, runShellStep, shellResult, succeeded } from './command';

type ParsedOutputs = { outputs: Record<string, string>; note: string | null };

const NO_OUTPUTS: ParsedOutputs = { outputs: {}, note: null };

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

export function parseActionOutputs(
  stdout: string,
  secrets: readonly string[],
): ParsedOutputs {
  const value = lastJsonObject(stdout);
  if (!value) return NO_OUTPUTS;
  const entries = Object.entries(value);
  const ignored = (reason: string): ParsedOutputs => ({
    outputs: {},
    note: `The JSON outputs on the last line were ignored: ${reason}`,
  });
  if (entries.length > stepResultLimits.outputs)
    return ignored(`return at most ${stepResultLimits.outputs} keys.`);
  const outputs: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      key.length > stepResultLimits.outputKey ||
      !STEP_OUTPUT_KEY_PATTERN.test(key) ||
      filterResultText(key, secrets) !== key
    )
      return ignored('an output name is not valid or looks like a secret.');
    if (typeof item !== 'string' || item.length > stepResultLimits.outputValue)
      return ignored(
        `every value must be text of at most ${stepResultLimits.outputValue} characters.`,
      );
    outputs[key] = filterResultText(item, secrets).slice(
      0,
      stepResultLimits.outputValue,
    );
  }
  return { outputs, note: null };
}

export const actionExecutor: StepExecutor = async (
  execution,
): Promise<StepOutcome> => {
  const run = await runShellStep(execution);
  if (!run) return { kind: 'interrupted' };
  const parsed = run.process
    ? parseActionOutputs(run.process.stdout, run.secrets)
    : NO_OUTPUTS;
  const done = succeeded(run);
  return {
    kind: 'result',
    result: shellResult(
      execution,
      run,
      done ? 'done' : 'error',
      outcomeSummary(
        run,
        execution.definition.timeout,
        parsed.note ? [parsed.note] : [],
      ),
      parsed.outputs,
    ),
  };
};
