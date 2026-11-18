export const providerInactivityLimitMs = 15 * 60_000;
export const maxTurnOutputBytes = 512 * 1024 * 1024;

const minimumCheckIntervalMs = 50;
const maximumCheckIntervalMs = 30_000;
const minimumTestLimitMs = 100;

export type InactivityWatchdog = {
  touch: () => void;
  stop: () => void;
};

export function providerInactivityLimit(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(environment.NESVO_TEST_PROVIDER_INACTIVITY_MS);
  return environment.NESVO_TEST_MODE === '1' &&
    Number.isInteger(override) &&
    override >= minimumTestLimitMs
    ? override
    : providerInactivityLimitMs;
}

function durationText(milliseconds: number): string {
  if (milliseconds >= 60_000) {
    const minutes = Math.round(milliseconds / 60_000);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export function inactivityFailure(provider: string, limitMs: number): string {
  return `${provider} turn stopped after ${durationText(limitMs)} without any activity from the provider.`;
}

export function watchInactivity(options: {
  limitMs: number;
  isWaiting: () => boolean;
  onInactive: () => void;
}): InactivityWatchdog {
  let lastActivity = Date.now();
  const interval = setInterval(
    () => {
      const now = Date.now();
      if (options.isWaiting()) {
        lastActivity = now;
        return;
      }
      if (now - lastActivity < options.limitMs) return;
      clearInterval(interval);
      options.onInactive();
    },
    Math.min(
      maximumCheckIntervalMs,
      Math.max(minimumCheckIntervalMs, Math.floor(options.limitMs / 10)),
    ),
  );
  return {
    touch: () => {
      lastActivity = Date.now();
    },
    stop: () => clearInterval(interval),
  };
}
