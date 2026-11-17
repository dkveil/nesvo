import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Brain,
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
import { CodeBlock } from '@/shared/ui/code-block';
import { NativeDisclosure } from '@/shared/ui/disclosure';

type Props = {
  runId: string;
  items: Activity[];
  startedAt: string | null;
  completedAt: string | null;
  status: Session['status'];
  live: boolean;
  truncated: boolean;
  offline?: boolean;
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
  const failed = item.status === 'failed';
  const Icon = failed ? CircleAlert : icons[item.kind];
  return (
    <NativeDisclosure
      data-activity-id={item.id}
      data-activity-kind={item.kind}
      data-activity-status={item.status}
      triggerLabel={`Activity: ${item.title}`}
      icon={<Icon className={failed ? 'text-error-foreground' : undefined} />}
      title={item.title}
      meta={activityStatusLabels[item.status]}
      contentClassName="ml-3.5 space-y-2 border-l pt-1 pb-3 pl-3"
    >
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
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
        <ul className="space-y-1">
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
          className="max-h-48 overflow-auto leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] italic"
        >
          {item.detail}
        </p>
      )}
      {item.detail && item.kind !== 'thinking' && (
        <CodeBlock
          aria-label="Activity details"
          code={item.detail}
          wrap
          maxHeightClassName="max-h-48"
        />
      )}
      {item.output && (
        <CodeBlock
          aria-label="Command output"
          code={item.output}
          wrap
          maxHeightClassName="max-h-56"
        />
      )}
      {item.truncated && (
        <p className="text-2xs">
          Only a bounded part of this activity was saved.
        </p>
      )}
    </NativeDisclosure>
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
  const label = offline
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
  const summary = live ? '' : activitySummary(items);
  const batches = activityBatches(items);
  return (
    <section
      ref={region}
      aria-label={`Activity for run ${runId}`}
      data-run-id={runId}
      className="min-w-0 text-muted-foreground"
    >
      <NativeDisclosure
        triggerLabel="Toggle activity"
        className="-mx-2"
        title={
          <span className="text-muted-foreground">
            <span
              className="activity-shimmer tabular-nums"
              data-animate={live && visible}
            >
              {label}
            </span>
            {completedTime && (
              <time
                dateTime={completedAt ?? undefined}
                className="ml-2 text-2xs tabular-nums"
              >
                {completedTime}
              </time>
            )}
            {running && (
              <span className="ml-2 text-xs" data-activity-current>
                · {running.title}
              </span>
            )}
            {summary && <span className="ml-2 text-xs">{summary}</span>}
            {failures > 0 && (
              <span className="ml-2 text-2xs text-error-foreground">
                {failures} failed
              </span>
            )}
          </span>
        }
        contentClassName="ml-3.5 max-h-80 space-y-px overflow-y-auto border-l pt-1 pl-2"
      >
        {batches.map(batch => {
          if (batch.items.length === 1)
            return <ActivityItem key={batch.id} item={batch.items[0]!} />;
          const Icon = icons[batch.kind];
          return (
            <NativeDisclosure
              key={batch.id}
              triggerLabel={`Toggle ${batch.kind} activity`}
              icon={<Icon />}
              title={batchLabel(batch)}
              contentClassName="ml-3.5 space-y-px border-l pt-0 pb-0 pl-2"
            >
              {batch.items.map(item => (
                <ActivityItem key={item.id} item={item} />
              ))}
            </NativeDisclosure>
          );
        })}
        {items.length === 0 && (
          <p className="px-2 py-1">No saved tool activity for this turn.</p>
        )}
        {truncated && (
          <p className="px-2 py-1 text-2xs">
            Some session activity was omitted by the saved-history limit.
          </p>
        )}
      </NativeDisclosure>
    </section>
  );
}
