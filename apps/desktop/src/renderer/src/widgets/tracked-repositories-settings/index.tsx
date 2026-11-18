import { useState } from 'react';
import type { Computer, TrackedRepository } from '@nesvo/contracts';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { recentPullRequestRepositories } from '@/entities/pull-request';
import { errorDetail } from '@/entities/session';
import {
  setTrackedRepositories,
  trackedRepositoriesUnavailableReason,
  useTrackedRepositories,
  type TrackedRepositoryApi,
} from '@/entities/tracked-repository';
import { TrackRepositoryDialog } from '@/features/track-repository';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';

type TrackedRepositoriesSettingsProps = {
  computer: Computer | undefined;
  api: TrackedRepositoryApi;
};

const moved = (items: TrackedRepository[], index: number, offset: number) => {
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(index + offset, 0, item!);
  return next.map(entry => entry.id);
};

export function TrackedRepositoriesSettings({
  computer,
  api,
}: TrackedRepositoriesSettingsProps) {
  const hostId = computer?.id ?? 'local';
  const unavailable = trackedRepositoriesUnavailableReason(computer);
  const tracked = useTrackedRepositories(api, hostId, !unavailable);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const apply = async (action: () => Promise<TrackedRepository[]>) => {
    setPending(true);
    setError('');
    try {
      setTrackedRepositories(hostId, await action());
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  if (unavailable) return <InlineNotice>{unavailable}</InlineNotice>;
  const repositories = tracked.repositories;
  const loading =
    (tracked.status === 'loading' || tracked.status === 'idle') &&
    repositories.length === 0;
  return (
    <div className="space-y-6">
      <p className="text-xs leading-5 text-muted-foreground">
        Tracked repositories are stored by {computer?.name ?? 'this'} computer’s
        host and listed together on the Pull requests page. The host checks each
        one with its GitHub CLI login.
      </p>
      {(tracked.status === 'error' || error) && (
        <StatusMessage tone="error">{error || tracked.error}</StatusMessage>
      )}
      <SettingsSection
        title="Tracked repositories"
        action={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending}
            aria-haspopup="dialog"
            onClick={() => setAdding(true)}
          >
            <Plus />
            Add repository
          </Button>
        }
      >
        {loading ? (
          <SkeletonList
            label="Loading tracked repositories"
            density="two-line"
            rows={2}
          />
        ) : repositories.length === 0 ? (
          <SettingsRow
            title="No tracked repositories"
            description="Track a repository by owner/name or link to list its pull requests next to your session folders."
          />
        ) : (
          repositories.map((item, index) => (
            <SettingsRow
              key={item.id}
              title={item.repository}
              description={item.directory ?? 'No local checkout'}
            >
              <IconButton
                label={`Move ${item.repository} up`}
                disabled={pending || index === 0}
                onClick={() =>
                  void apply(() =>
                    api.reorderTrackedRepositories({
                      ids: moved(repositories, index, -1),
                    }),
                  )
                }
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                label={`Move ${item.repository} down`}
                disabled={pending || index === repositories.length - 1}
                onClick={() =>
                  void apply(() =>
                    api.reorderTrackedRepositories({
                      ids: moved(repositories, index, 1),
                    }),
                  )
                }
              >
                <ArrowDown />
              </IconButton>
              <IconButton
                label={`Stop tracking ${item.repository}`}
                tone="danger"
                disabled={pending}
                onClick={() =>
                  void apply(() => api.removeTrackedRepository({ id: item.id }))
                }
              >
                <Trash2 />
              </IconButton>
            </SettingsRow>
          ))
        )}
      </SettingsSection>
      {adding && (
        <TrackRepositoryDialog
          open
          onOpenChange={setAdding}
          api={api}
          hostId={hostId}
          computerName={computer?.name ?? 'This computer'}
          tracked={repositories}
          recentRepositories={recentPullRequestRepositories(hostId)}
        />
      )}
    </div>
  );
}
