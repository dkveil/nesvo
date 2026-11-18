import { parseUntilCondition } from '@nesvo/contracts';
import type { StepExecutor } from '../runner';
import { hostResult } from './host-result';

export const untilExecutor: StepExecutor = async execution => {
  const { definition, step, outputs } = execution;
  const iteration = step.iteration ?? 1;
  const condition =
    definition.condition && parseUntilCondition(definition.condition);
  if (!condition || !definition.max_iterations)
    return hostResult(
      execution,
      'fail',
      'The loop condition or iteration limit is invalid.',
    );
  const value = outputs.get(condition.step)?.[condition.key];
  const matched =
    value !== undefined &&
    (condition.operator === '=='
      ? value === condition.value
      : value !== condition.value);
  const details = { iteration: String(iteration), matched: String(matched) };
  if (matched)
    return hostResult(
      execution,
      'pass',
      'The loop condition matched.',
      details,
    );
  if (iteration >= definition.max_iterations)
    return hostResult(
      execution,
      'fail',
      'The loop reached its iteration limit.',
      details,
    );
  const { result } = hostResult(
    execution,
    'pass',
    'The loop condition did not match. Repeating the sequence.',
    details,
  );
  return { kind: 'repeat', result };
};
