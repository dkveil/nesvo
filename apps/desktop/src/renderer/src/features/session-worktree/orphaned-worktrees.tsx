import { useState } from 'react';
import type {
  Computer,
  DesktopApi,
  OrphanedSessionWorktrees,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  api: Pick<
    DesktopApi,
    'listOrphanedSessionWorktrees' | 'removeOrphanedSessionWorktree'
  >;
  computers: Computer[];
};

export function OrphanedWorktrees({ api, computers }: Props) {
  return (
    <SettingsSection title="Worktree cleanup">
      {computers.map(computer => (
        <ComputerWorktrees key={computer.id} api={api} computer={computer} />
      ))}
    </SettingsSection>
  );
}

function ComputerWorktrees({
  api,
  computer,
}: {
  api: Props['api'];
  computer: Computer;
}) {
  const [worktrees, setWorktrees] = useState<OrphanedSessionWorktrees>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<{
    worktree: OrphanedSessionWorktrees[number];
    force: boolean;
  }>();
  const unavailable =
    computer.status !== 'connected'
      ? 'Connect this computer to manage its worktrees.'
      : !computer.capabilities.includes('session-worktree-tools')
        ? 'Update this computer’s host to manage its worktrees.'
        : '';

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setWorktrees(await api.listOrphanedSessionWorktrees(computer.id));
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    if (!target || unavailable) return true;
    const { worktree, force } = target;
    setError('');
    try {
      const result = await api.removeOrphanedSessionWorktree(
        { id: worktree.id, force },
        computer.id,
      );
      if (result === 'dirty') {
        setTarget({ worktree, force: true });
        return false;
      }
      setWorktrees(items => items?.filter(item => item.id !== worktree.id));
      return true;
    } catch (failure) {
      setError(errorDetail(failure));
      return false;
    }
  };

  return (
    <>
      <SettingsRow
        title={computer.name}
        description={
          unavailable ||
          'Find retained worktrees and checkouts without a session.'
        }
      >
        <Button
          variant="outline"
          onClick={() => void refresh()}
          disabled={!!unavailable || loading}
        >
          {loading ? 'Checking…' : worktrees ? 'Refresh' : 'Find worktrees'}
        </Button>
      </SettingsRow>
      {error && !target && <StatusMessage tone="error">{error}</StatusMessage>}
      {!unavailable && worktrees?.length === 0 && (
        <StatusMessage tone="info">
          No worktrees available for cleanup.
        </StatusMessage>
      )}
      {!unavailable &&
        worktrees?.map(item => (
          <SettingsRow
            key={item.id}
            title={item.sessionTitle || item.branch}
            description={
              <div className="min-w-0 space-y-1">
                {item.sessionTitle && <p>{item.branch}</p>}
                <p className="break-all font-mono text-2xs">{item.directory}</p>
              </div>
            }
          >
            <Button
              variant="outline"
              onClick={() => {
                setError('');
                setTarget({ worktree: item, force: false });
              }}
            >
              Remove
            </Button>
          </SettingsRow>
        ))}
      {target && (
        <ConfirmDialog
          key={target.force ? 'force' : 'remove'}
          open
          onOpenChange={next => {
            if (!next) setTarget(undefined);
          }}
          title={target.force ? 'Discard local changes?' : 'Remove worktree?'}
          description={
            target.force
              ? `Removing ${target.worktree.branch} will discard its uncommitted changes and local files.`
              : `Permanently remove the worktree for ${target.worktree.branch}. Its Git branch is kept.`
          }
          confirmLabel={target.force ? 'Discard and remove' : 'Remove worktree'}
          pendingLabel="Removing…"
          onConfirm={remove}
        >
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </ConfirmDialog>
      )}
    </>
  );
}
