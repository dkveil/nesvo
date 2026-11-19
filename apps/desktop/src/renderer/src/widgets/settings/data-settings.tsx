import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { useState } from 'react';
import type { Computer, DatabaseBackup, DesktopApi } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { OrphanedWorktrees } from '@/features/session-worktree/orphaned-worktrees';
import { Button } from '@/shared/ui/button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { DataPrivacySettings } from './data-privacy-settings';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  api: DesktopApi;
  computers: Computer[];
};

type BackupState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'done'; backup: DatabaseBackup }
  | { status: 'error'; message: string };

const sizeFormat = new Intl.NumberFormat('en', {
  maximumFractionDigits: 1,
});

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  return `${sizeFormat.format(bytes / 1024 / 1024)} MB`;
}

function unavailableReason(computer: Computer) {
  if (computer.status !== 'connected')
    return `${computer.name} is offline. Connect it to back up its data.`;
  if (!computer.capabilities.includes('database-backup'))
    return 'Update this computer’s Nesvo host and reconnect to back up its data.';
  return '';
}

export function DataSettings({ api, computers }: Props) {
  const [backups, setBackups] = useState<Record<string, BackupState>>({});
  const [showError, setShowError] = useState('');
  const backUp = async (computer: Computer) => {
    setBackups(previous => ({
      ...previous,
      [computer.id]: { status: 'pending' },
    }));
    try {
      const backup = await api.backupDatabase(computer.id);
      setBackups(previous => ({
        ...previous,
        [computer.id]: { status: 'done', backup },
      }));
    } catch (failure) {
      setBackups(previous => ({
        ...previous,
        [computer.id]: { status: 'error', message: errorDetail(failure) },
      }));
    }
  };
  const show = (path: string) => {
    setShowError('');
    void api
      .showBackup(path)
      .catch(() => setShowError('The backup could not be shown.'));
  };
  return (
    <div className="space-y-8">
      <DataPrivacySettings
        api={api}
        localConnected={computers.some(
          computer =>
            computer.kind === 'local' && computer.status === 'connected',
        )}
      />
      <SettingsSection title="Backups">
        {computers.map(computer => {
          const state = backups[computer.id] ?? { status: 'idle' };
          const reason = unavailableReason(computer);
          return (
            <SettingsRow
              key={computer.id}
              title={computer.name}
              description={
                <div className="space-y-1">
                  <p>
                    Writes a consistent copy of the session database next to the
                    original.
                  </p>
                  {reason && <p>{reason}</p>}
                  {state.status === 'pending' && (
                    <StatusMessage tone="loading">
                      Writing the backup…
                    </StatusMessage>
                  )}
                  {state.status === 'error' && (
                    <StatusMessage tone="error">{state.message}</StatusMessage>
                  )}
                  {state.status === 'done' && (
                    <>
                      <StatusMessage tone="success">
                        Backup written · {formatBytes(state.backup.bytes)}
                      </StatusMessage>
                      <MiddleTruncatedText
                        path
                        value={state.backup.path}
                        className="font-mono"
                      />
                    </>
                  )}
                </div>
              }
            >
              {state.status === 'done' && computer.kind === 'local' && (
                <Button variant="ghost" onClick={() => show(state.backup.path)}>
                  Show in folder
                </Button>
              )}
              <Button
                variant="outline"
                disabled={!!reason || state.status === 'pending'}
                onClick={() => void backUp(computer)}
              >
                Back up data now
              </Button>
            </SettingsRow>
          );
        })}
      </SettingsSection>
      {showError && <StatusMessage tone="error">{showError}</StatusMessage>}
      <OrphanedWorktrees api={api} computers={computers} />
      <SettingsSection title="Export">
        <SettingsRow
          title="Sessions"
          description="Export a session as Markdown from its menu in the session header."
        />
      </SettingsSection>
    </div>
  );
}
