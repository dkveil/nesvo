import type { RunningApp } from '@nesvo/contracts';

export function runningAppsSummary(apps: readonly RunningApp[]): string {
  const [first, ...rest] = apps;
  if (!first) return '';
  return rest.length ? `:${first.port} +${rest.length}` : `:${first.port}`;
}
