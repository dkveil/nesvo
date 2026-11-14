import {
  useEffect,
  useEffectEvent,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Computer } from '@nesvo/contracts';
import { FolderOpen, GitBranch, Monitor, Server } from 'lucide-react';
import { cn } from 'cn';
import type { PipelineRun } from '@/entities/pipeline';
import { directoryLabel, type Session } from '@/entities/session';
import {
  cardIcon,
  cardIconButton,
  cardRow,
  cardRowAction,
  cardSection,
  cardSurface,
} from '@/shared/ui/card-row-styles';

export { PipelineSection } from './pipeline-section';
export { UsageSection } from './usage-section';
export { WorkersSection } from './workers-section';

type Props = {
  id: string;
  computer: Computer | undefined;
  connection: 'connecting' | 'ready' | 'unavailable';
  session: Session | null;
  run: PipelineRun | undefined;
  pipeline: ReactNode;
  workers: ReactNode;
  usage: ReactNode;
  onComputers: () => void;
  onFiles: () => void;
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
  pipeline,
  workers,
  usage,
  onComputers,
  onFiles,
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
      <div className={cardSection}>
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            data-card-row
            className={cn(cardRowAction, 'min-w-0 flex-1 font-normal')}
            aria-label={`Computer: ${name}, ${connectionLabels[connection]}`}
            title="Manage computers"
            onClick={onComputers}
          >
            <HostIcon className={cardIcon} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {name}
            </span>
            {connection !== 'ready' && (
              <span
                className={cn(
                  'shrink-0 text-2xs text-muted-foreground',
                  connection === 'unavailable' && 'text-warning-foreground',
                )}
              >
                {connectionLabels[connection]}
              </span>
            )}
          </button>
          {session && (
            <button
              type="button"
              className={cn(cardIconButton, 'mr-1')}
              aria-label={`Browse files in ${directoryLabel(session.directory)}`}
              title={session.directory}
              onClick={onFiles}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {branch && (
        <div className={cardSection}>
          <p className={cardRow} title={branch}>
            <GitBranch className={cardIcon} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{branch}</span>
          </p>
        </div>
      )}
      {pipeline}
      {workers}
      {usage}
    </aside>
  );
}
