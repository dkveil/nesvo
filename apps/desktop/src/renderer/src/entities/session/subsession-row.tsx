import type { ComponentProps } from 'react';
import { Square } from 'lucide-react';
import type { SubsessionEntry } from '@nesvo/contracts';
import { elapsedLabel } from '@/entities/activity';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { StatusDot } from '@/shared/ui/status-dot';
import { ProviderGlyph } from './provider-glyph';
import { directoryLabel, modelLabel, type Session } from './index';
import {
  statusTextTones,
  subsessionStatus,
  type SubsessionStatus,
} from './subsession-status';

type SubsessionRowProps = {
  entry: SubsessionEntry<Session>;
  now: number;
  density?: 'two-line' | 'compact';
  parentDirectory?: string;
  stopping?: boolean;
  stopDisabled?: boolean;
  onOpen: () => void;
  onStop?: () => void;
  mainProps?: ComponentProps<typeof ListRow>['mainProps'];
};

function ProviderMark({
  session,
  status,
}: {
  session: Session;
  status: SubsessionStatus;
}) {
  const badge = status.attention || status.variant === 'spinner';
  return (
    <span className="relative inline-flex">
      <ProviderGlyph provider={session.provider} />
      {badge && (
        <StatusDot
          tone={status.tone}
          variant={status.variant}
          ringClassName="border-info-panel"
          className={cn(
            'absolute -right-1 -bottom-1',
            status.variant === 'spinner' && 'bg-info-panel',
          )}
        />
      )}
    </span>
  );
}

export function SubsessionRow({
  entry,
  now,
  density = 'two-line',
  parentDirectory,
  stopping = false,
  stopDisabled = false,
  onOpen,
  onStop,
  mainProps,
}: SubsessionRowProps) {
  const { session, active, startedAt, finishedAt } = entry;
  const status = subsessionStatus(session, stopping);
  const elapsed = elapsedLabel(startedAt, finishedAt, now);
  const model = modelLabel(session.actualModel ?? session.model);
  const folder =
    parentDirectory && session.directory !== parentDirectory
      ? directoryLabel(session.directory)
      : '';
  const compact = density === 'compact';
  const stateWord = status.attention && (
    <span className={statusTextTones[status.tone]}>{status.state}</span>
  );
  const elapsedText = elapsed && (
    <span className="text-muted-foreground tabular-nums">{elapsed}</span>
  );
  return (
    <ListRow
      density={density}
      size={compact ? 'md' : 'sm'}
      data-subsession-row=""
      data-active={active ? '' : undefined}
      className={cn(!active && 'opacity-60')}
      leading={
        compact ? (
          <ProviderMark session={session} status={status} />
        ) : (
          <StatusDot tone={status.tone} variant={status.variant} size="md" />
        )
      }
      title={session.title}
      meta={
        compact ? undefined : (
          <>
            {stateWord}
            {elapsedText}
          </>
        )
      }
      description={
        compact ? undefined : (
          <span className="flex min-w-0 items-center gap-1">
            <ProviderGlyph provider={session.provider} className="size-3" />
            <span className="truncate">
              {folder ? `${model} · ${folder}` : model}
            </span>
          </span>
        )
      }
      trailing={
        compact ? (
          <>
            {stateWord}
            {elapsedText}
          </>
        ) : undefined
      }
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
        'aria-label': [
          `Open ${session.title}`,
          status.state,
          elapsed,
          `${session.provider} ${model}`,
          folder,
        ]
          .filter(Boolean)
          .join(', '),
      }}
      onClick={onOpen}
    />
  );
}
