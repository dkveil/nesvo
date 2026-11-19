export const STEP_OUTPUT_REFERENCE =
  /^steps\.([a-z0-9]+(?:-[a-z0-9]+)*)\.outputs\.([A-Za-z][A-Za-z0-9_.-]{0,63})$/;

export function readWorkflowOutput(
  outputs: ReadonlyMap<string, Readonly<Record<string, string>>>,
  step: string,
  key: string,
): string | undefined {
  const values = outputs.get(step);
  return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

const conditionPattern = /^(\S+) (==|!=) ("(?:[^"\\\r\n]|\\.)*")$/;

export function parseWorkflowCondition(expression: string) {
  const condition = conditionPattern.exec(expression.trim());
  if (!condition) return null;
  const input = condition[1]!;
  const reference = STEP_OUTPUT_REFERENCE.exec(input);
  if (!reference && input !== 'stack' && input !== 'lane') return null;
  try {
    const value: unknown = JSON.parse(condition[3]!);
    if (typeof value !== 'string') return null;
    return {
      input: reference
        ? { kind: 'output' as const, step: reference[1]!, key: reference[2]! }
        : { kind: input as 'stack' | 'lane' },
      operator: condition[2]!,
      value,
    };
  } catch {
    return null;
  }
}

export function parseUntilCondition(expression: string) {
  const condition = parseWorkflowCondition(expression);
  if (condition?.input.kind !== 'output') return null;
  const { input, ...comparison } = condition;
  return { step: input.step, key: input.key, ...comparison };
}
