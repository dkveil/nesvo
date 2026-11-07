import { activityLimits, type SessionActivity } from '@nesvo/contracts';

export type ProviderActivity = Omit<SessionActivity, 'runId'>;

export function activityText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(
      /(?:sk-ant-|sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g,
      '[redacted]',
    )
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(
      /((?:[\w-]*(?:api[_-]?key|token|password|secret)[\w-]*)["']?\s*[:=]\s*["']?)[^\s,"';]+/gi,
      '$1[redacted]',
    );
}

export function makeActivity(input: {
  id: string;
  kind: SessionActivity['kind'];
  title: string;
  status: SessionActivity['status'];
  startedAt?: string;
  completedAt?: string | null;
  detail?: string | null;
  output?: string;
  paths?: string[];
  truncated?: boolean;
}): ProviderActivity {
  if (!input.id || input.id.length > 200)
    throw new Error('Provider returned an invalid activity ID.');
  const detail = input.detail == null ? null : activityText(input.detail);
  const output = activityText(input.output ?? '');
  const paths = [...new Set(input.paths ?? [])].map(activityText);
  const now = new Date().toISOString();
  return {
    id: input.id,
    kind: input.kind,
    title: activityText(input.title).slice(0, 200),
    status: input.status,
    startedAt: input.startedAt ?? now,
    completedAt: input.status === 'running' ? null : (input.completedAt ?? now),
    detail: detail?.slice(0, activityLimits.detail) ?? null,
    output: output.slice(-activityLimits.output),
    paths: paths
      .slice(0, activityLimits.paths)
      .map(path => path.slice(0, activityLimits.pathLength)),
    truncated:
      input.truncated === true ||
      (detail?.length ?? 0) > activityLimits.detail ||
      output.length > activityLimits.output ||
      paths.length > activityLimits.paths ||
      paths.some(path => path.length > activityLimits.pathLength),
  };
}
