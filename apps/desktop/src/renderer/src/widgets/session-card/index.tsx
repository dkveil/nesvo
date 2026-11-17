import {
  useEffect,
  useEffectEvent,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Computer } from '@nesvo/contracts';
import { FolderOpen, GitBranch, Monitor, Play, Server } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import type { WorkflowRun } from '@/entities/workflow';
import { directoryLabel, type Session } from '@/entities/session';
import { cardSection, cardSurface } from '@/shared/ui/card-row-styles';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import { cardRowProps } from './card-row';

export { WorkflowSection } from './workflow-section';
export { UsageSection } from './usage-section';
export { WorkersSection } from './workers-section';

type Props = {
  id: string;
  computer: Computer | undefined;
  connection: 'connecting' | 'ready' | 'unavailable';
  session: Session | null;
  run: WorkflowRun | undefined;
  workflow: ReactNode;
  workers: ReactNode;
  usage: ReactNode;
  onComputers: () => void;
  onFiles: () => void;
  onRunWorkflow: () => void;
  onClose: () => void;
};

const connectionLabels: Record<Props['connection'], string> = {
  ready: 'Connected',
  connecting: 'Connecting…',
  unavailable: 'Offline',
};

const ROW_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

const moveBetweenRows = (event: KeyboardEvent<HTMLElement>) => {
  if (
    !ROW_KEYS.includes(event.key) ||
    event.defaultPrevented ||
    !(event.target instanceof Node) ||
    !event.currentTarget.contains(event.target)
  )
    return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[data-card-row]'),
  ];
  if (rows.length === 0) return;
  const index = rows.findIndex(row => row === document.activeElement);
  if (index < 0 && event.target !== event.currentTarget) return;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : index < 0
          ? 0
          : Math.min(
              Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0),
              rows.length - 1,
            );
  event.preventDefault();
  rows[next]?.focus();
};

const isInsideLayer = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest('[role="dialog"], [role="menu"], [role="alertdialog"]');

export function SessionCard({
  id,
  computer,
  connection,
  session,
  run,
  workflow,
  workers,
  usage,
  onComputers,
  onFiles,
  onRunWorkflow,
  onClose,
}: Props) {
  const card = useRef<HTMLElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        isInsideLayer(event.target)
      )
        return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const name = computer?.name ?? 'Local';
  const HostIcon = computer?.kind === 'ssh' ? Server : Monitor;
  const branch = run?.isolation?.branch;
  return (
    <aside
      ref={card}
      id={id}
      tabIndex={-1}
      aria-label="Session details"
      onKeyDown={moveBetweenRows}
      className={cn(
        cardSurface,
        'absolute top-2 right-3 z-20 flex max-h-[calc(100%-1rem)] w-58 flex-col divide-y overflow-y-auto shadow-(--popover-shadow) outline-none',
      )}
    >
      <div className={cn(cardSection, 'flex min-w-0 items-center gap-1')}>
        <ListRow
          className="flex-1"
          leading={<HostIcon />}
          title={<span className="text-muted-foreground">{name}</span>}
          trailing={
            connection !== 'ready' && (
              <span
                className={cn(
                  connection === 'unavailable' && 'text-warning-foreground',
                )}
              >
                {connectionLabels[connection]}
              </span>
            )
          }
          mainProps={{
            ...cardRowProps,
            'aria-label': `Computer: ${name}, ${connectionLabels[connection]}`,
          }}
          onClick={onComputers}
        />
        {session && (
          <IconButton
            size={24}
            label={`Browse files in ${directoryLabel(session.directory)}`}
            className="mr-1"
            onClick={onFiles}
          >
            <FolderOpen />
          </IconButton>
        )}
      </div>
      {branch && (
        <div className={cardSection}>
          <ListRow leading={<GitBranch />} title={branch} />
        </div>
      )}
      {session && (
        <div className={cardSection} data-session-workflow-section>
          <SectionLabel
            as="h2"
            action={
              <span
                className="min-w-0 truncate text-2xs text-muted-foreground"
                data-assigned-workflow={session.workflow?.name ?? ''}
              >
                {session.workflow
                  ? `${session.workflow.name} · ${session.workflow.root === 'project' ? 'Project' : 'Global'}`
                  : 'None'}
              </span>
            }
          >
            Workflow
          </SectionLabel>
          <ListRow
            leading={<Play />}
            title="Run workflow"
            disabled={
              !session.workflow ||
              session.status === 'running' ||
              session.status === 'stopping'
            }
            mainProps={cardRowProps}
            onClick={onRunWorkflow}
          />
        </div>
      )}
      {workflow}
      {workers}
      {usage}
    </aside>
  );
}
