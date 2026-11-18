import type { StageReport } from '@nesvo/contracts';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';

type Props = { id?: string; report: StageReport; source: 'tool' | 'answer' };

const noteSections = [
  ['deadEnds', 'Dead ends'],
  ['assumptions', 'Assumptions'],
  ['later', 'For later'],
  ['systemRemarks', 'Remarks about the system'],
] as const;

export function ReportCard({ id, report, source }: Props) {
  return (
    <section
      id={id}
      aria-label="Report"
      className="space-y-3 rounded-surface border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Report</h2>
        <Badge tone={report.status === 'ok' ? 'success' : 'error'}>
          {report.status === 'ok' ? 'OK' : 'Failed'}
        </Badge>
        <span className="text-2xs text-muted-foreground">
          {source === 'tool' ? 'Sent with the stage tool' : 'From the answer'}
        </span>
      </div>
      <p className="text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
        {report.summary}
      </p>
      {report.links.length > 0 && (
        <ul aria-label="Links" className="space-y-1">
          {report.links.map(link => (
            <li key={link.url}>
              <Button
                type="button"
                variant="link"
                size="inline"
                className="max-w-full justify-start"
                onClick={() =>
                  void window.nesvo
                    ?.openExternal(link.url)
                    ?.catch(() => undefined)
                }
              >
                <span className="truncate">{link.title ?? link.url}</span>
                <ArrowUpRight className="size-3 text-muted-foreground" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {noteSections.map(([key, label]) =>
        report.notes[key].length ? (
          <div key={key} className="space-y-1">
            <h3 className="text-2xs text-muted-foreground">{label}</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-ui">
              {report.notes[key].map((note, index) => (
                <li key={index} className="[overflow-wrap:anywhere]">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}
