import {
  isWritableSessionMode,
  type DesktopSession as Session,
} from '@nesvo/contracts';

const comparablePath = (directory: string) => {
  const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
};

const contains = (parent: string, child: string) =>
  child === parent || child.startsWith(`${parent}/`);

export const foldersOverlap = (left: string, right: string) => {
  const first = comparablePath(left);
  const second = comparablePath(right);
  return contains(first, second) || contains(second, first);
};

const isWorking = (session: Session) =>
  session.status === 'running' || session.status === 'stopping';

const groupOf = (session: Session) =>
  session.role === 'worker' && session.parentId ? session.parentId : session.id;

export const folderBlocker = (
  session: Session,
  sessions: readonly Session[],
): Session | undefined =>
  sessions.find(
    other =>
      other.hostId === session.hostId &&
      other.id !== session.id &&
      isWorking(other) &&
      groupOf(other) !== groupOf(session) &&
      (isWritableSessionMode(other.mode) ||
        isWritableSessionMode(session.mode)) &&
      foldersOverlap(other.directory, session.directory),
  );
