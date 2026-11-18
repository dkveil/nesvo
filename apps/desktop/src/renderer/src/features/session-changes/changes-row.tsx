import { GitCompareArrows } from 'lucide-react';
import type { Session } from '@/entities/session';
import { DiffStat } from '@/entities/file-change';
import { ListRow } from '@/shared/ui/list-row';
import {
  changeSetOf,
  preferredScope,
  useSessionChanges,
  type SessionChangesApi,
} from './use-session-changes';

type ChangesRowProps = {
  session: Session;
  api: SessionChangesApi;
  onOpen: () => void;
};

export function ChangesRow({ session, api, onOpen }: ChangesRowProps) {
  const { changes, loading, error } = useSessionChanges(session, api);
  const set = changeSetOf(changes, preferredScope(changes));
  const available = set?.status === 'available';
  return (
    <ListRow
      leading={<GitCompareArrows />}
      title="Changes"
      trailing={
        available ? (
          <DiffStat additions={set.additions} deletions={set.deletions} />
        ) : error ? (
          'Unavailable'
        ) : loading ? (
          'Reading…'
        ) : set ? (
          'No Git'
        ) : null
      }
      mainProps={{
        'data-card-row': '',
        'aria-label': available
          ? `Changes: ${set.additions} added, ${set.deletions} removed`
          : 'Changes',
      }}
      onClick={onOpen}
    />
  );
}
