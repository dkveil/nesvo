import { useEffect, useState } from 'react';
import type {
  Computer,
  DesktopScheduledJob,
  SessionMessageWatcherReply,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { ConfigurationChangeRow } from '@/features/configuration/change-row';
import { useConfigurationChanges } from '@/features/configuration/use-configuration-changes';
import { Button } from '@/shared/ui/button';
import { Disclosure } from '@/shared/ui/disclosure';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

type Watcher = Extract<
  SessionMessageWatcherReply,
  { action: 'read' }
>['watchers'][number];

export function SetupActivation({ computer }: { computer: Computer }) {
  const { id: hostId, capabilities } = computer;
  const hasJobs = capabilities.includes('scheduled-jobs');
  const hasWatchers = capabilities.includes('session-message-watchers');
  const [jobs, setJobs] = useState<DesktopScheduledJob[]>([]);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reviews = useConfigurationChanges(
    [computer],
    'pending',
    'setup-review',
  );

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
    <div className="mx-auto max-w-lg space-y-3 text-left">
      {reviews.length > 0 && (
        <Disclosure
          title="Review local approvals"
          meta={reviews.length}
          contentClassName="pl-0"
        >
          {reviews.map(change => (
            <ConfigurationChangeRow
              key={change.id}
              change={change}
              computer={computer.name}
              online
            />
          ))}
        </Disclosure>
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
                    const updated = await window.nesvo.scheduledJobs.setActive(
                      hostId,
                      job.id,
                      !job.active,
                      job.revision,
                    );
                    setJobs(items =>
                      items.map(item => (item.id === job.id ? updated : item)),
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
                        action: watcher.state === 'running' ? 'stop' : 'start',
                        actionId: crypto.randomUUID(),
                        watcherId: watcher.id,
                      },
                      hostId,
                    );
                    const result = await window.nesvo.sessionMessageWatchers(
                      { action: 'read' },
                      hostId,
                    );
                    if (result.action === 'read') setWatchers(result.watchers);
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
  );
}
