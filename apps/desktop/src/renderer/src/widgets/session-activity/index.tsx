import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Brain,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import { cn } from 'cn';
import type { Session } from '@nesvo/contracts';
import {
  activityBatches,
  activityStatusLabels,
  activitySummary,
  batchLabel,
  commandOutputParts,
  elapsedLabel,
  ExitCodeBadge,
  hiddenActivityLabel,
  isRoutineActivity,
  runLabel,
  type SessionActivity as Activity,
} from '@/entities/activity';
import { useToolVisibility } from '@/features/tool-visibility';
import { Badge } from '@/shared/ui/badge';

type Props = {
  runId: string;
  items: Activity[];
  startedAt: string | null;
  completedAt: string | null;
  status: Session['status'];
  live: boolean;
  truncated: boolean;
  offline?: boolean;
  waiting?: boolean;
};

const icons = {
  command: Terminal,
  'file-change': FilePenLine,
  read: BookOpen,
  search: Search,
  tool: Wrench,
  thinking: Brain,
};

function ActivityItem({ item }: { item: Activity }) {
  const Icon = item.status === 'failed' ? CircleAlert : icons[item.kind];
  const declined = item.status === 'declined';
  const command =
    item.kind === 'command' && item.detail
      ? (item.detail.split('\n')[0] ?? '')
      : '';
  const output = commandOutputParts(item);
  return (
    <details
      data-activity-id={item.id}
      data-activity-kind={item.kind}
      data-activity-status={item.status}
      className="group/activity-item"
    >
      <summary
        aria-label={`Activity: ${item.title}`}
        className="flex cursor-pointer list-none items-start gap-2 rounded-md px-1.5 py-1 text-[13px] leading-5 text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset group-open/activity-item:text-foreground [&::-webkit-details-marker]:hidden"
      >
        <Icon
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground',
            item.status === 'failed' && 'text-destructive',
          )}
        />
        <span className="min-w-0 flex-1">
          {command ? (
            <code
              className="block truncate font-mono text-xs leading-5"
              title={command}
            >
              {command}
            </code>
          ) : (
            <span className="block [overflow-wrap:anywhere]">{item.title}</span>
          )}
          {declined && item.detail && !command && (
            <span
              aria-label="Refusal detail"
              className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]"
            >
              {item.detail}
            </span>
          )}
        </span>
        {item.kind === 'command' && item.exitCode !== null && (
          <ExitCodeBadge code={item.exitCode} className="mt-0.5" />
        )}
        {declined ? (
          <Badge
            variant="outline"
            className="mt-0.5 h-4 rounded-sm px-1 text-2xs leading-none font-normal text-muted-foreground"
          >
            Refused
          </Badge>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {activityStatusLabels[item.status]}
          </span>
        )}
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
        {item.detail && item.kind === 'thinking' && (
          <p
            aria-label="Thinking"
            className="max-h-48 overflow-auto text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] italic text-muted-foreground"
          >
            {item.detail}
          </p>
        )}
        {item.detail &&
          item.kind !== 'thinking' &&
          item.detail !== command &&
          (command || !declined) && (
            <pre
              aria-label="Activity details"
              className="max-h-48 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {item.detail}
            </pre>
          )}
        {item.output && (
          <pre
            aria-label="Command output"
            className="max-h-56 overflow-auto rounded-lg border bg-code-background p-3 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {output.stdout && (
              <span data-output-stream="stdout" className="block">
                {output.stdout}
              </span>
            )}
            {output.stderr && (
              <span
                data-output-stream="stderr"
                className={cn(
                  'block text-muted-foreground',
                  output.stdout && 'mt-2 border-t border-dashed pt-2',
                )}
              >
                {output.stderr}
              </span>
            )}
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
  offline = false,
  waiting = false,
}: Props) {
  const [visibility] = useToolVisibility();
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
  const label = waiting
    ? 'Waiting for your answer'
    : offline
      ? `Last known: ${status === 'stopping' ? 'Stopping' : 'Working'}`
      : runLabel(status, elapsed, live);
  const completedTime =
    !live && !offline && completedAt
      ? new Date(completedAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  const running = live
    ? items.findLast(item => item.status === 'running')
    : undefined;
  const failures = items.filter(item => item.status === 'failed').length;
  const refusals = items.filter(item => item.status === 'declined').length;
  const summary = live ? '' : activitySummary(items);
  const compact = visibility === 'compact';
  const hidden = compact ? items.filter(isRoutineActivity) : [];
  const shown = compact
    ? items.filter(item => !isRoutineActivity(item))
    : items;
  const hiddenNote = hiddenActivityLabel(hidden);
  const batches = activityBatches(shown);
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
          className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-[13px] leading-5 transition-colors duration-100 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight className="activity-caret size-3 shrink-0 group-open/activity:rotate-90" />
          <span
            className="activity-shimmer shrink-0 tabular-nums"
            data-animate={live && visible && !waiting}
          >
            {label}
          </span>
          {completedTime && (
            <time
              dateTime={completedAt ?? undefined}
              className="shrink-0 text-[11px] tabular-nums"
            >
              {completedTime}
            </time>
          )}
          {running && (
            <span
              className="min-w-0 truncate text-xs"
              title={running.title}
              data-activity-current
            >
              · {running.title}
            </span>
          )}
          {summary && (
            <span className="min-w-0 truncate text-xs" title={summary}>
              {summary}
            </span>
          )}
          {failures > 0 && (
            <span className="shrink-0 text-[11px] text-destructive">
              {failures} failed
            </span>
          )}
          {refusals > 0 && (
            <span className="shrink-0 text-[11px]">{refusals} refused</span>
          )}
        </summary>
        <div className="mt-1.5 ml-1.5 max-h-80 space-y-px overflow-y-auto border-l pl-2.5">
          {batches.map(batch => {
            if (batch.items.length === 1)
              return <ActivityItem key={batch.id} item={batch.items[0]!} />;
            const Icon = icons[batch.kind];
            return (
              <details key={batch.id} className="group/activity-batch">
                <summary
                  aria-label={`Toggle ${batch.kind} activity`}
                  className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-[13px] leading-5 transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset [&::-webkit-details-marker]:hidden"
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
          {hiddenNote && (
            <p
              aria-label="Hidden activity"
              data-hidden-activity={hidden.length}
              className="px-1.5 py-1 text-[11px]"
            >
              {hiddenNote}
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
