import { CircleX, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import type { DocumentIssue } from '@/entities/pipeline-graph';

type Props = {
  issues: DocumentIssue[];
  banner: string | null;
  open: boolean;
};

export function IssuesStrip({ issues, banner, open }: Props) {
  if (!banner && (!open || issues.length === 0)) return null;
  return (
    <div
      role={banner ? 'alert' : 'status'}
      data-editor-issues
      className="shrink-0 border-b bg-card/60 px-3 py-1.5 text-xs"
    >
      {banner && (
        <p className="flex items-center gap-2 text-error-foreground [overflow-wrap:anywhere]">
          <CircleX className="size-3.5 shrink-0" aria-hidden="true" />
          {banner}
        </p>
      )}
      {open && (
        <ul className="max-h-32 space-y-0.5 overflow-y-auto">
          {issues.map((issue, index) => {
            const error = issue.severity === 'error';
            const Icon = error ? CircleX : TriangleAlert;
            return (
              <li
                key={`${issue.message}-${index}`}
                className="flex items-start gap-2 leading-5"
              >
                <Icon
                  role="img"
                  aria-label={error ? 'Error' : 'Warning'}
                  className={cn(
                    'mt-1 size-3.5 shrink-0',
                    error ? 'text-error-foreground' : 'text-warning-foreground',
                  )}
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {issue.message}
                </span>
              </li>
            );
          })}
          {issues.length === 0 && (
            <li className="text-muted-foreground">No issues.</li>
          )}
        </ul>
      )}
    </div>
  );
}
