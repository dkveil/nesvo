import { stepResultLimits, type StepResult } from '@nesvo/contracts';
import type { StepExecution } from '../runner';

export function hostResult(
  execution: StepExecution,
  status: StepResult['status'],
  summary: string,
  outputs: StepResult['outputs'] = {},
  evidence: StepResult['evidence'] = [],
): { kind: 'result'; result: StepResult } {
  const { step } = execution;
  const finishedAt = execution.now().toISOString();
  const startedAt = step.startedAt ?? finishedAt;
  return {
    kind: 'result',
    result: {
      name: step.name,
      type: step.type,
      phase: step.phase,
      status,
      summary: summary.slice(0, stepResultLimits.summary),
      evidence,
      outputs,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      cost: {
        usd: null,
        inputTokens: null,
        outputTokens: null,
        provider: null,
      },
      attempt: Math.max(step.attempt, 1),
    },
  };
}
