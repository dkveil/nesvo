import { useStore } from '@nanostores/react';

import { Button } from '../../../shared/components/button';
import { ListRow } from '../../../shared/components/list-row';
import { StatusBadge, type StatusBadgeTone } from '../../../shared/components/status-badge';
import type { SessionRowState } from '../contracts/session-snapshot';
import { $sessionRows, $snapshot } from '../core/sessions-store';

export type SessionsScreenProps = {
  onRefresh: () => Promise<void>;
};

const STATE_TONES: Record<SessionRowState, StatusBadgeTone> = {
  working: 'accent',
  idle: 'neutral',
  done: 'positive',
  blocked: 'warning',
  question: 'warning',
  failed: 'critical',
  unknown: 'neutral',
  exited: 'neutral',
};

const PROGRAM_COLORS = {
  shell: 'bg-program-terminal',
  claude: 'bg-program-claude',
  gemini: 'bg-program-gemini',
  codex: 'bg-program-codex',
} as const;

export const SessionsScreen = ({ onRefresh }: SessionsScreenProps) => {
  const rows = useStore($sessionRows);
  const snapshot = useStore($snapshot);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          Sessions <span className="text-muted">({rows.length})</span>
        </h1>
        <Button variant="secondary" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {snapshot ? null : <p className="text-muted">Waiting for the host snapshot.</p>}
      {snapshot && rows.length === 0 ? (
        <p className="text-muted">No sessions on this host.</p>
      ) : null}
      <ul className="flex flex-col gap-2" aria-label="Sessions">
        {rows.map(row => (
          <ListRow key={row.id} variant={row.needsAttention ? 'attention' : 'default'}>
            <span
              className={`size-2.5 shrink-0 rounded-full ${PROGRAM_COLORS[row.program]}`}
              title={row.program}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{row.name}</p>
              <p className="truncate text-xs text-muted">
                {row.groupName ? `${row.groupName} · ` : ''}
                {row.cwd}
              </p>
            </div>
            <StatusBadge tone={STATE_TONES[row.state]}>{row.state}</StatusBadge>
          </ListRow>
        ))}
      </ul>
    </div>
  );
};
