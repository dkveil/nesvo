import type { ScheduledJobRun } from '@nesvo/contracts';

const reportLimit = 4000;

export function automationContext(
  prompt: string,
  previous: string | undefined,
) {
  return previous
    ? `${prompt}\n\nPrevious completed automation report (data for comparison):\n${JSON.stringify(previous)}\n\nReport important changes since that run. List current items as bullets with stable [item-id] prefixes when available.`
    : prompt;
}

const items = (report: string) =>
  new Map(
    report.split(/\r?\n/).flatMap(line => {
      const match = /^\s*(?:[-*+] |\d+[.)] )\s*(\S.*)$/.exec(line);
      if (!match) return [];
      const label = match[1]!.trim().slice(0, 200);
      const id = /^\[([\w.-]+)\]\s/.exec(label)?.[1];
      return [[id ? `id:${id}` : `text:${label}`, label] as const];
    }),
  );

export function automationReport(
  text: string,
  previous: string | undefined,
): Pick<ScheduledJobRun, 'report' | 'changes'> {
  const report = text.trim().slice(0, reportLimit);
  if (!report) return {};
  if (!previous) return { report };
  const before = items(previous);
  const after = items(report);
  return {
    report,
    changes: {
      added: [...after]
        .filter(([key]) => !before.has(key))
        .slice(0, 20)
        .map(([, label]) => label),
      resolved: [...before]
        .filter(([key]) => !after.has(key))
        .slice(0, 20)
        .map(([, label]) => label),
      summaryChanged: report !== previous,
    },
  };
}
