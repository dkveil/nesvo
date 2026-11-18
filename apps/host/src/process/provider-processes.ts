import { linuxProcessStartedAt } from '../running-apps/scan';

export const PROVIDER_SESSION_VARIABLE = 'NESVO_SESSION_ID';

const MAX_RECORDED_PROCESSES = 1024;

export type ProviderProcess = {
  sessionId: string;
  recordedAt: number;
  startedAt: number | null;
};

const recorded = new Map<number, ProviderProcess>();

export function recordProviderProcess(
  pid: number | undefined,
  environment?: Readonly<Record<string, string>>,
): void {
  const sessionId = environment?.[PROVIDER_SESSION_VARIABLE];
  if (!pid || !sessionId) return;
  recorded.delete(pid);
  recorded.set(pid, {
    sessionId,
    recordedAt: Date.now(),
    startedAt: linuxProcessStartedAt(pid),
  });
  if (recorded.size <= MAX_RECORDED_PROCESSES) return;
  const oldest = recorded.keys().next();
  if (!oldest.done) recorded.delete(oldest.value);
}

export function providerProcess(pid: number): ProviderProcess | undefined {
  return recorded.get(pid);
}
