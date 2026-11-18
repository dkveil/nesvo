import type { WorkflowChildItem, WorkflowChildReport } from '@nesvo/contracts';
import { hostKey } from '@/shared/lib/host-key';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';

const states = {
  waiting: 'Waiting',
  starting: 'Starting',
  running: 'Running',
  finished: 'Finished',
};
const statuses: Record<WorkflowChildReport['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  rejected: 'Rejected',
  'needs-attention': 'Needs attention',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  skipped: 'Skipped',
};

export function ChildQueue({
  items,
  hostId,
  onSession,
}: {
  items: WorkflowChildItem[];
  hostId: string;
  onSession: (key: string) => void;
}) {
  return (
    <section aria-label="Child sessions" className="space-y-1">
      <SectionLabel className="px-0">Child sessions</SectionLabel>
      <ul className="divide-y divide-border">
        {items.map(({ index, title, sessionId, state, reason, report }) => (
          <li key={index} className="space-y-1 py-1">
            <ListRow
              title={title}
              size="sm"
              trailing={report ? statuses[report.status] : states[state]}
              onClick={
                sessionId
                  ? () => onSession(hostKey(sessionId, hostId))
                  : undefined
              }
            />
            {(reason || report?.summary) && (
              <p className="whitespace-pre-wrap break-words px-2 text-2xs text-muted-foreground">
                {reason ?? report?.summary}
              </p>
            )}
            {report?.links.map(link => (
              <p
                key={link}
                className="break-all px-2 text-2xs text-muted-foreground select-text"
              >
                {link}
              </p>
            ))}
            {report?.notes.map((note, i) => (
              <p
                key={i}
                className="break-words px-2 text-2xs text-muted-foreground"
              >
                {note}
              </p>
            ))}
            {report && Object.keys(report.outputs).length > 0 && (
              <KeyValueList
                className="px-2 font-mono text-2xs"
                entries={Object.entries(report.outputs).map(([key, value]) => ({
                  key,
                  label: key,
                  value,
                }))}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
