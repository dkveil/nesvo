export type PushTarget = { hostId: string; sessionId: string; sequence: number };
export function parseTarget(value: unknown): PushTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  return typeof v.hostId === 'string' &&
    /^[a-f0-9]{32}$/.test(v.hostId) &&
    typeof v.sessionId === 'string' &&
    /^[a-f0-9]{32}$/.test(v.sessionId) &&
    typeof v.sequence === 'number' &&
    Number.isSafeInteger(v.sequence) &&
    v.sequence > 0
    ? { hostId: v.hostId, sessionId: v.sessionId, sequence: v.sequence }
    : null;
}
