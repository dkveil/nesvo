import { useEffect, useState } from 'react';
import type {
  Computer,
  DesktopScheduledJob,
  SessionMessageWatcherReply,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { ConfigurationChangeRow } from '@/features/configuration/change-row';
import { useConfigurationChanges } from '@/features/configuration/use-configuration-changes';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { PanelBody } from '@/shared/ui/panel';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';

type Watcher = Extract<
  SessionMessageWatcherReply,
  { action: 'read' }
>['watchers'][number];

export function SetupActivation({
  computer,
  onReviewOpenChange,
}: {
  computer: Computer;
  onReviewOpenChange: (open: boolean) => void;
}) {
  const { id: hostId, capabilities } = computer;
  const hasJobs = capabilities.includes('scheduled-jobs');
  const hasWatchers = capabilities.includes('session-message-watchers');
  const [jobs, setJobs] = useState<DesktopScheduledJob[]>([]);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const reviews = useConfigurationChanges(
    [computer],
    'pending',
    'setup-review',
  );
  const visibleReviews = reviews.filter(change =>
    reviewIds.includes(change.id),
  );
  const reviewing = visibleReviews.length > 0;

  useEffect(() => {
    if (!reviewing) return;
    onReviewOpenChange(true);
    return () => onReviewOpenChange(false);
  }, [onReviewOpenChange, reviewing]);

  useEffect(() => {
    let mounted = true;
    let generation = 0;
    const read = async () => {
      const requested = ++generation;
      const [jobResult, watcherResult] = await Promise.allSettled([
        hasJobs ? window.nesvo.scheduledJobs.list(hostId) : [],
        hasWatchers
          ? window.nesvo.sessionMessageWatchers({ action: 'read' }, hostId)
          : undefined,
      ]);
      if (!mounted || requested !== generation) return;
      if (jobResult.status === 'fulfilled')
        setJobs(jobResult.value.filter(job => job.profileOwnership));
      if (
        watcherResult.status === 'fulfilled' &&
        watcherResult.value?.action === 'read'
      )
        setWatchers(watcherResult.value.watchers);
      const failure = [jobResult, watcherResult].find(
        result => result.status === 'rejected',
      );
      if (failure) setError(errorDetail(failure.reason));
    };
    const unsubscribe = window.nesvo.subscribe(event => {
      if (
        event.type === 'configuration-changed' &&
        event.hostId === hostId &&
        event.change.target.area === 'setup-review' &&
        event.change.status !== 'pending'
      )
        void read();
    });
    void read();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [hostId, hasJobs, hasWatchers]);

  const activate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (issue) {
      setError(errorDetail(issue));
    } finally {
      setBusy(false);
    }
  };

  if (!jobs.length && !watchers.length && !reviews.length && !error)
    return null;
  return (
    <div className="relative flex min-w-0 gap-4 text-left">
      <div
        className={cn(
          'min-w-0 flex-1 space-y-3',
          !reviewing && 'mx-auto max-w-lg',
        )}
      >
        {reviews.length > 0 && (
          <SettingsRow
            title="Local approvals"
            description={`${reviews.length} to review`}
          >
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={reviewing}
              onClick={() => setReviewIds(reviews.map(change => change.id))}
            >
              Review local approvals
            </Button>
          </SettingsRow>
        )}
        {(jobs.length > 0 || watchers.length > 0) && (
          <SettingsSection title="Automations and watchers">
            {jobs.map(job => (
              <SettingsRow
                key={job.id}
                title={job.name}
                description={
                  job.profileOwnership === 'withheld'
                    ? 'Awaiting local review'
                    : job.active
                      ? 'Armed'
                      : 'Paused'
                }
              >
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    busy || (!job.active && job.profileOwnership === 'withheld')
                  }
                  onClick={() =>
                    void activate(async () => {
                      const updated =
                        await window.nesvo.scheduledJobs.setActive(
                          hostId,
                          job.id,
                          !job.active,
                          job.revision,
                        );
                      setJobs(items =>
                        items.map(item =>
                          item.id === job.id ? updated : item,
                        ),
                      );
                    })
                  }
                >
                  {job.active ? 'Pause' : 'Arm'}
                </Button>
              </SettingsRow>
            ))}
            {watchers.map(watcher => (
              <SettingsRow
                key={watcher.id}
                title={watcher.name}
                description={
                  watcher.detail ??
                  { idle: 'Ready', running: 'Running', held: 'Held' }[
                    watcher.state
                  ]
                }
              >
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void activate(async () => {
                      await window.nesvo.sessionMessageWatchers(
                        {
                          action:
                            watcher.state === 'running' ? 'stop' : 'start',
                          actionId: crypto.randomUUID(),
                          watcherId: watcher.id,
                        },
                        hostId,
                      );
                      const result = await window.nesvo.sessionMessageWatchers(
                        { action: 'read' },
                        hostId,
                      );
                      if (result.action === 'read')
                        setWatchers(result.watchers);
                    })
                  }
                >
                  {watcher.state === 'running' ? 'Stop' : 'Start'}
                </Button>
              </SettingsRow>
            ))}
          </SettingsSection>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </div>
      {reviewing && (
        <SidePanel
          kind="details"
          aria-label="Local approvals"
          resizeLabel="Resize local approvals"
          className="h-80"
          focusOnOpen
          onEscape={() => setReviewIds([])}
        >
          <SidePanelHeader
            titleBar={false}
            title="Local approvals"
            closeLabel="Close local approvals"
            onClose={() => setReviewIds([])}
          />
          <PanelBody className="px-2">
            {visibleReviews.map(change => (
              <ConfigurationChangeRow
                key={change.id}
                change={change}
                computer={computer.name}
                online
              />
            ))}
          </PanelBody>
        </SidePanel>
      )}
    </div>
  );
}
