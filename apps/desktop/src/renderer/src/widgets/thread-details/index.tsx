import type { ReactNode } from 'react';
import {
  ChevronRight,
  FolderOpen,
  Lock,
  Monitor,
  Pencil,
  Server,
} from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from 'cn';
import {
  directoryLabel,
  modeLabels,
  modelLabel,
  ProviderGlyph,
  type Session,
} from '@/entities/session';
import { effortLabel } from '@/features/new-thread/reasoning-effort';

type Props = {
  id: string;
  computer: Computer | undefined;
  connection: 'connecting' | 'ready' | 'unavailable';
  session: Session | null;
  usage: ReactNode;
  onComputers: () => void;
  onFiles: () => void;
};

const connectionLabels: Record<Props['connection'], string> = {
  ready: 'Connected',
  connecting: 'Connecting…',
  unavailable: 'Offline',
};

const rowClass =
  'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] font-medium';

const actionClass = cn(
  rowClass,
  'group/row text-foreground transition-colors duration-100 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
);

export function ThreadDetails({
  id,
  computer,
  connection,
  session,
  usage,
  onComputers,
  onFiles,
}: Props) {
  const name = computer?.name ?? 'Local';
  const HostIcon = computer?.kind === 'ssh' ? Server : Monitor;
  const ModeIcon = session?.mode === 'supervised' ? Pencil : Lock;
  const model = session
    ? (session.actualModel ?? modelLabel(session.model))
    : '';
  return (
    <aside
      id={id}
      aria-label="Thread details"
      className="absolute top-2 right-3 z-20 w-62 rounded-xl border bg-card p-1.5 text-card-foreground shadow-(--popover-shadow)"
    >
      <div className="space-y-px">
        <button
          type="button"
          className={actionClass}
          aria-label={`Computer: ${name}, ${connectionLabels[connection]}`}
          title="Manage computers"
          onClick={onComputers}
        >
          <HostIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span
            className={cn(
              'shrink-0 text-xs font-normal text-muted-foreground',
              connection === 'unavailable' && 'text-warning-foreground',
            )}
          >
            {connectionLabels[connection]}
          </span>
        </button>
        {session && (
          <>
            <button
              type="button"
              className={actionClass}
              aria-label={`Browse files in ${directoryLabel(session.directory)}`}
              title={session.directory}
              onClick={onFiles}
            >
              <FolderOpen
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">
                {directoryLabel(session.directory)}
              </span>
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
                aria-hidden="true"
              />
            </button>
            <p className={rowClass} title={`${session.provider} · ${model}`}>
              <ProviderGlyph provider={session.provider} className="mx-px" />
              <span className="min-w-0 truncate">{model}</span>
              {session.effort && (
                <span className="shrink-0 font-normal text-muted-foreground">
                  {effortLabel(session.effort)}
                </span>
              )}
            </p>
            <p className={rowClass}>
              <ModeIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">
                {modeLabels[session.mode]}
              </span>
            </p>
          </>
        )}
      </div>
      <section
        aria-labelledby={`${id}-usage`}
        className="mt-1.5 space-y-1 border-t px-1 pt-2.5 pb-1"
      >
        <h2
          id={`${id}-usage`}
          className="px-1.5 text-2xs font-medium text-muted-foreground"
        >
          Usage
        </h2>
        {usage}
      </section>
    </aside>
  );
}
