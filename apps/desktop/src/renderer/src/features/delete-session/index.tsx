import { useEffect, useRef, useState } from 'react';
import type {
  DesktopApi,
  DesktopSession,
  DesktopSessionDeletion,
} from '@nesvo/contracts';
import { errorDetail, type Session } from '@/entities/session';
import { hostKey } from '@/shared/lib/host-key';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { StatusMessage } from '@/shared/ui/status-message';
import { Toast, ToastRegion } from '@/shared/ui/toast';

type DeletionApi = Pick<DesktopApi, 'deleteSession' | 'restoreSession'>;

type Pending = DesktopSessionDeletion & {
  key: string;
  expiresAt: number;
  restoring: boolean;
  error: string;
};

type Props = {
  target: Session | null;
  onClose: () => void;
  api: (hostId: string) => DeletionApi;
  onDeleted: (deletion: DesktopSessionDeletion) => void;
  onRestored: (session: DesktopSession) => void;
};

const VISIBLE_TOASTS = 3;

const secondsLabel = (milliseconds: number) => {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
};

export function SessionDeletion({
  target,
  onClose,
  api,
  onDeleted,
  onRestored,
}: Props) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);
  const dismiss = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setPending(previous => previous.filter(item => item.key !== key));
  };
  const confirm = async () => {
    if (!target) return true;
    setError('');
    try {
      const deletion = await api(target.hostId).deleteSession({
        sessionId: target.id,
      });
      const key = hostKey(deletion.sessionId, deletion.hostId);
      const period =
        Date.parse(deletion.purgeAfter) - Date.parse(deletion.deletedAt);
      clearTimeout(timers.current.get(key));
      timers.current.set(
        key,
        setTimeout(() => dismiss(key), Math.max(0, period)),
      );
      setPending(previous => [
        ...previous.filter(item => item.key !== key),
        {
          ...deletion,
          title: deletion.title || target.title,
          key,
          expiresAt: Date.now() + period,
          restoring: false,
          error: '',
        },
      ]);
      onDeleted(deletion);
      return true;
    } catch (failure) {
      setError(`The session could not be deleted. ${errorDetail(failure)}`);
      return false;
    }
  };
  const undo = async (item: Pending) => {
    setPending(previous =>
      previous.map(entry =>
        entry.key === item.key
          ? { ...entry, restoring: true, error: '' }
          : entry,
      ),
    );
    try {
      const session = await api(item.hostId).restoreSession({
        sessionId: item.sessionId,
      });
      dismiss(item.key);
      onRestored(session);
    } catch (failure) {
      setPending(previous =>
        previous.map(entry =>
          entry.key === item.key
            ? {
                ...entry,
                restoring: false,
                error: `The session could not be restored. ${errorDetail(failure)}`,
              }
            : entry,
        ),
      );
    }
  };
  return (
    <>
      <ConfirmDialog
        open={!!target}
        onOpenChange={open => {
          if (open) return;
          setError('');
          onClose();
        }}
        title="Delete session?"
        description={`“${target?.title ?? ''}” and its history, saved results and subsessions are deleted from this computer. You can undo this for a few seconds afterwards. Worktree folders stay on disk.`}
        confirmLabel="Delete session"
        pendingLabel="Deleting…"
        onConfirm={confirm}
      >
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
      {pending.length > 0 && (
        <ToastRegion>
          {pending.slice(-VISIBLE_TOASTS).map(item => (
            <Toast
              key={item.key}
              data-session-deletion={item.sessionId}
              tone={item.error ? 'error' : item.restoring ? 'loading' : 'info'}
              title={
                item.error ||
                (item.restoring
                  ? `Restoring “${item.title}”…`
                  : `Deleted “${item.title}”`)
              }
              description={
                item.error || item.restoring
                  ? undefined
                  : `Undo within ${secondsLabel(item.expiresAt - Date.now())}`
              }
              action={{
                label: item.error ? 'Try again' : 'Undo',
                disabled: item.restoring,
                onClick: () => void undo(item),
              }}
              onDismiss={() => dismiss(item.key)}
              dismissLabel="Dismiss deletion notice"
            />
          ))}
        </ToastRegion>
      )}
    </>
  );
}
