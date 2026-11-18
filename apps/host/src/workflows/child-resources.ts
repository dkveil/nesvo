import { cpus, freemem } from 'node:os';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Provider,
  ProviderUsage,
  WorkflowChildPolicy,
} from '@nesvo/contracts';

const mib = 1024 * 1024;

function cpuTimes() {
  return cpus().reduce(
    (total, { times }) => ({
      idle: total.idle + times.idle,
      all:
        total.all + Object.values(times).reduce((sum, time) => sum + time, 0),
    }),
    { idle: 0, all: 0 },
  );
}

async function cpuLoad(signal: AbortSignal): Promise<number | null> {
  const before = cpuTimes();
  await delay(200, undefined, { signal });
  const after = cpuTimes();
  return after.all > before.all
    ? 100 * (1 - (after.idle - before.idle) / (after.all - before.all))
    : null;
}

function testResources(environment: NodeJS.ProcessEnv) {
  const path = environment.NESVO_TEST_WORKFLOW_RESOURCES;
  if (environment.NESVO_TEST_MODE !== '1' || !path) return null;
  try {
    const fixture: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!fixture || typeof fixture !== 'object') return null;
    return fixture as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fixtureNumber(value: unknown, max = Infinity): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

export async function childStartWait(
  execution: { signal: AbortSignal; environment: NodeJS.ProcessEnv },
  provider: Provider,
  policy: WorkflowChildPolicy,
  active: number,
  usage: () => Promise<ProviderUsage>,
): Promise<string | null> {
  if (active >= policy.max_parallel)
    return `Waiting: all ${policy.max_parallel} parallel slots are in use.`;
  const soft = policy.soft_limit !== undefined && active >= policy.soft_limit;
  const fixture = testResources(execution.environment);
  const minRam = Math.ceil(policy.min_free_ram_mb * (soft ? 1.25 : 1));
  if ((fixtureNumber(fixture?.freeRamMb) ?? freemem() / mib) < minRam)
    return `Waiting: free RAM below ${minRam} MiB.`;

  const observation = await usage();
  execution.signal.throwIfAborted();
  if (observation.status !== 'ready')
    return `Waiting: ${provider} account unavailable (${observation.status}).`;
  if (observation.ordinaryUsageAllowed === false)
    return `Waiting: ${provider} plan usage is restricted.`;
  const plan =
    fixtureNumber(fixture?.remainingPercent, 100) ??
    (observation.windows.length
      ? Math.max(
          0,
          100 -
            Math.max(...observation.windows.map(window => window.usedPercent)),
        )
      : null);
  if (plan === null) return 'Waiting: provider plan usage unavailable.';
  const minPlan = Math.min(
    100,
    policy.min_plan_remaining_percent + (soft ? 10 : 0),
  );
  if (plan <= 0 || plan < minPlan)
    return `Waiting: provider limit below ${minPlan || 1}%.`;
  if (policy.max_cpu_load_percent !== undefined) {
    const maxCpu = policy.max_cpu_load_percent * (soft ? 0.8 : 1);
    const load =
      fixtureNumber(fixture?.cpuLoadPercent, 100) ??
      (await cpuLoad(execution.signal));
    if (load === null) return 'Waiting: CPU load unavailable.';
    if (load > maxCpu)
      return `Waiting: CPU load above ${Number(maxCpu.toFixed(2))}%.`;
  }
  return null;
}
