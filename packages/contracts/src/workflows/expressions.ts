export const STEP_OUTPUT_REFERENCE =
  /^steps\.([a-z0-9]+(?:-[a-z0-9]+)*)\.outputs\.([A-Za-z][A-Za-z0-9_.-]{0,63})$/;

const conditionPattern = /^(steps\.\S+) (==|!=) ("(?:[^"\\\r\n]|\\.)*")$/;

export function parseUntilCondition(expression: string) {
  const condition = conditionPattern.exec(expression.trim());
  if (!condition) return null;
  const reference = STEP_OUTPUT_REFERENCE.exec(condition[1]!);
  if (!reference) return null;
  try {
    const value: unknown = JSON.parse(condition[3]!);
    if (typeof value !== 'string') return null;
    return { step: reference[1]!, key: reference[2]!, operator: condition[2]!, value };
  } catch {
    return null;
  }
}
