import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { Session } from '@nesvo/contracts';
import {
  activityBatches,
  activityStatusLabels,
  activitySummary,
  batchLabel,
  elapsedLabel,
  runLabel,
  type SessionActivity as Activity,
} from '@/entities/activity';

type Props = {
  runId: string;
  items: Activity[];
  startedAt: string | null;
  completedAt: string | null;
  status: Session['status'];
  live: boolean;
  truncated: boolean;
};

const icons = {
  command: Terminal,
  'file-change': FilePenLine,
  read: BookOpen,
  search: Search,
  tool: Wrench,
};

function ActivityItem({ item }: { item: Activity }) {
  const Icon = item.status === 'failed' ? CircleAlert : icons[item.kind];
  return (
    <details
      data-activity-id={item.id}
      data-activity-kind={item.kind}
      data-activity-status={item.status}
      className="group/activity-item"
    >
      <summary
        aria-label={`Activity: ${item.title}`}
        className="flex cursor-pointer list-none items-start gap-2 rounded-sm py-1 text-[13px] leading-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
      >
        <Icon
          className={`mt-0.5 size-3.5 shrink-0 ${item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
        />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {item.title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {activityStatusLabels[item.status]}
        </span>
        <ChevronRight className="activity-caret mt-1 size-3 shrink-0 text-muted-foreground group-open/activity-item:rotate-90" />
      </summary>
      <div className="ml-5.5 space-y-2 border-l pl-3 pt-1 pb-3">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <time dateTime={item.startedAt}>
            Started {new Date(item.startedAt).toLocaleTimeString('en')}
          </time>
          {item.completedAt && (
            <time dateTime={item.completedAt}>
              Finished {new Date(item.completedAt).toLocaleTimeString('en')} ·{' '}
              {elapsedLabel(item.startedAt, item.completedAt, 0)}
            </time>
          )}
        </div>
        {item.paths.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {[...new Set(item.paths)].filter(Boolean).map(path => (
              <li key={path} className="[overflow-wrap:anywhere]">
                {path}
              </li>
            ))}
          </ul>
        )}
        {item.detail && (
          <pre
            aria-label="Activity details"
            className="max-h-48 overflow-auto text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {item.detail}
          </pre>
        )}
        {item.output && (
          <pre
            aria-label="Command output"
            className="max-h-56 overflow-auto rounded-md bg-card p-3 text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {item.output}
          </pre>
        )}
        {item.truncated && (
          <p className="text-[11px] text-muted-foreground">
            Only a bounded part of this activity was saved.
          </p>
        )}
      </div>
    </details>
  );
}

export function SessionActivity({
  runId,
  items,
  startedAt,
  completedAt,
  status,
  live,
  truncated,
}: Props) {
  const region = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    let intersecting = false;
    const updateVisibility = () =>
      setVisible(intersecting && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(entries => {
      intersecting = entries.some(entry => entry.isIntersecting);
      updateVisibility();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);
  useEffect(() => {
    if (!live || !visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, visible]);
  const elapsed =
    startedAt && (completedAt || live)
      ? elapsedLabel(startedAt, completedAt, now)
      : '';
  const label = runLabel(status, elapsed, live);
  const latest =
    items.findLast(item => item.status === 'running') ?? items.at(-1);
  const failures = items.filter(item => item.status === 'failed').length;
  const summary =
    live && latest
      ? `${latest.status === 'running' ? '' : 'Last: '}${latest.title}`
      : activitySummary(items);
  const batches = activityBatches(items);
  return (
    <section
      ref={region}
      aria-label={`Activity for run ${runId}`}
      data-run-id={runId}
      className="min-w-0 text-muted-foreground"
    >
      <details className="group/activity">
        <summary
          aria-label="Toggle activity"
          className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 text-xs leading-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight className="activity-caret size-3 shrink-0 group-open/activity:rotate-90" />
          <span
            className="activity-shimmer shrink-0 tabular-nums"
            data-animate={live && visible}
          >
            {label}
          </span>
          {summary && (
            <span className="min-w-0 truncate text-[11px]" title={summary}>
              {summary}
            </span>
          )}
          {failures > 0 && (
            <span className="shrink-0 text-[11px] text-destructive">
              {failures} failed
            </span>
          )}
        </summary>
        <div className="mt-2 max-h-80 space-y-1 overflow-y-auto border-l pl-3">
          {batches.map(batch => {
            if (batch.items.length === 1)
              return <ActivityItem key={batch.id} item={batch.items[0]!} />;
            const Icon = icons[batch.kind];
            return (
              <details key={batch.id} className="group/activity-batch">
                <summary
                  aria-label={`Toggle ${batch.kind} activity`}
                  className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 text-[13px] leading-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span>{batchLabel(batch)}</span>
                  <ChevronRight className="activity-caret ml-auto size-3 shrink-0 group-open/activity-batch:rotate-90" />
                </summary>
                <div className="ml-1.5 space-y-1 border-l pl-3">
                  {batch.items.map(item => (
                    <ActivityItem key={item.id} item={item} />
                  ))}
                </div>
              </details>
            );
          })}
          {items.length === 0 && (
            <p className="py-1 text-xs">
              No saved tool activity for this turn.
            </p>
          )}
          {truncated && (
            <p className="py-1 text-[11px]">
              Some session activity was omitted by the saved-history limit.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
