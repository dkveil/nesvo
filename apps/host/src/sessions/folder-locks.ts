import { basename, isAbsolute, relative, sep } from 'node:path';
import type { SessionFolderWait } from '@nesvo/contracts';

export type FolderAccess = 'read' | 'write';

export type FolderOperation = SessionFolderWait['operation'];

export type FolderRequest = {
  directory: string;
  access: FolderAccess;
  group: string | null;
};

export type FolderClaim = FolderRequest & {
  operation: FolderOperation;
  sessionId: string | null;
};

export type FolderWait = SessionFolderWait;

const comparable = (directory: string) =>
  process.platform === 'win32' ? directory.toLowerCase() : directory;

const contains = (parent: string, child: string) => {
  const path = relative(comparable(parent), comparable(child));
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
};

export const foldersOverlap = (left: string, right: string) =>
  contains(left, right) || contains(right, left);

const conflicts = (request: FolderRequest, claim: FolderClaim) =>
  (request.access === 'write' || claim.access === 'write') &&
  !(request.group && request.group === claim.group) &&
  foldersOverlap(request.directory, claim.directory);

export const folderName = (directory: string) =>
  basename(directory) || directory;

export const folderWaitMessage = (wait: FolderWait) =>
  `Waiting for ${folderName(wait.directory)}, which ${
    wait.operation === 'run'
      ? 'another session is using'
      : wait.operation === 'checkout'
        ? 'a pull request checkout is changing'
        : wait.operation === 'review'
          ? 'a result decision is checking'
          : wait.operation === 'fork'
            ? 'a fork is reading'
            : wait.operation === 'worktree-setup'
              ? 'a setup script is using'
              : 'a worktree removal is changing'
  }.`;

export class FolderLocks {
  private readonly claims = new Set<FolderClaim>();
  private readonly listeners = new Set<() => void>();
  private notifying = false;

  blocker(request: FolderRequest): FolderClaim | undefined {
    for (const claim of this.claims)
      if (conflicts(request, claim)) return claim;
    return undefined;
  }

  claimed(directory: string, operation: FolderOperation): boolean {
    for (const claim of this.claims)
      if (
        claim.operation === operation &&
        foldersOverlap(directory, claim.directory)
      )
        return true;
    return false;
  }

  tryAcquire(claim: FolderClaim): FolderWait | (() => void) {
    const blocker = this.blocker(claim);
    if (blocker)
      return {
        directory: blocker.directory,
        operation: blocker.operation,
        sessionId: blocker.sessionId,
      };
    this.claims.add(claim);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.claims.delete(claim);
      this.announce();
    };
  }

  onRelease(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  whenFree(request: FolderRequest, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (signal.aborted) {
          stop();
          reject(signal.reason);
        } else if (!this.blocker(request)) {
          stop();
          resolve();
        }
      };
      const unsubscribe = this.onRelease(check);
      const stop = () => {
        unsubscribe();
        signal.removeEventListener('abort', check);
      };
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }

  private announce(): void {
    if (this.notifying) return;
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch {
          continue;
        }
      }
    });
  }
}
