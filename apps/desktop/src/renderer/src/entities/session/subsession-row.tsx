import type { ComponentProps } from 'react';
import { ChevronRight, Folder, GitBranch, Square } from 'lucide-react';
import type { SubsessionEntry } from '@nesvo/contracts';
import { elapsedLabel } from '@/entities/activity';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { StatusDot, type StatusDotTone } from '@/shared/ui/status-dot';
import { ProviderGlyph } from './provider-glyph';
import {
  directoryLabel,
  modelLabel,
  sessionStatusLabel,
  type Session,
} from './index';

type SubsessionRowProps = {
  entry: SubsessionEntry<Session>;
  now: number;
  stopping?: boolean;
  stopDisabled?: boolean;
  onOpen: () => void;
  onStop?: () => void;
  mainProps?: ComponentProps<typeof ListRow>['mainProps'];
};

const stateTone = (session: Session, state: string): StatusDotTone => {
  if (state === 'Needs approval') return 'warning';
  if (session.status === 'running' || session.status === 'stopping')
    return 'info';
  if (session.status === 'completed') return 'success';
  if (session.status === 'failed') return 'error';
  return 'neutral';
};

const stateText: Partial<Record<StatusDotTone, string>> = {
  info: 'text-info-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
};

export function SubsessionRow({
  entry,
  now,
  stopping = false,
  stopDisabled = false,
  onOpen,
  onStop,
  mainProps,
}: SubsessionRowProps) {
  const { session, active, startedAt, finishedAt } = entry;
  const state = stopping ? 'Stopping…' : sessionStatusLabel(session);
  const tone = stateTone(session, state);
  const elapsed = elapsedLabel(startedAt, finishedAt, now);
  const model = modelLabel(session.actualModel ?? session.model);
  const branch = session.worktree?.branch;
  const location = branch ?? directoryLabel(session.directory);
  return (
    <ListRow
      density="two-line"
      data-subsession-row=""
      data-active={active ? '' : undefined}
      className={cn(!active && 'opacity-60')}
      leading={
        <StatusDot tone={tone} size="md" pulse={active && tone === 'info'} />
      }
      title={session.title}
      meta={
        <>
          <span className={stateText[tone]}>{state}</span>
          {elapsed && <span>{elapsed}</span>}
        </>
      }
      description={
        <span className="flex min-w-0 items-center gap-1">
          <ProviderGlyph provider={session.provider} className="size-3" />
          <span className="shrink-0">{model}</span>
          <span aria-hidden="true">·</span>
          {branch ? (
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <Folder className="size-3 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{location}</span>
        </span>
      }
      trailing={<ChevronRight className="size-3.5" aria-hidden="true" />}
      actionsPlacement="visible"
      actions={
        active && onStop ? (
          <IconButton
            size={24}
            tone="danger"
            label={`Stop ${session.title}`}
            disabled={stopDisabled || stopping || session.status === 'stopping'}
            onClick={onStop}
          >
            <Square className="fill-current" />
          </IconButton>
        ) : undefined
      }
      mainProps={{
        ...mainProps,
        'aria-label': `Open ${session.title}, ${state}${elapsed ? `, ${elapsed}` : ''}, ${session.provider} ${model}, ${location}`,
      }}
      onClick={onOpen}
    />
  );
}
