import { useCallback, useEffect, useState } from 'react';
import type { Computer } from '@nesvo/contracts';

export type DefaultSessionFolders = {
  folders: Readonly<Record<string, string | null>>;
  supported: (hostId: string) => boolean;
  save: (hostId: string, directory: string | null) => Promise<string | null>;
};

export function supportsDefaultFolder(computer: Computer | undefined) {
  return (
    computer?.status === 'connected' &&
    computer.capabilities.includes('default-session-folder')
  );
}

export function useDefaultSessionFolders(
  computers: readonly Computer[],
): DefaultSessionFolders {
  const [folders, setFolders] = useState<Record<string, string | null>>({});
  const targets = computers
    .filter(supportsDefaultFolder)
    .map(computer => `${computer.id}\t${computer.lastSyncedAt ?? ''}`)
    .join('\n');
  useEffect(() => {
    if (!targets || !window.nesvo) return;
    let cancelled = false;
    for (const target of targets.split('\n')) {
      const [hostId = 'local'] = target.split('\t');
      void window.nesvo
        .readDefaultSessionFolder(hostId)
        .then(directory => {
          if (!cancelled)
            setFolders(previous => ({ ...previous, [hostId]: directory }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [targets]);
  const supported = useCallback(
    (hostId: string) =>
      supportsDefaultFolder(computers.find(item => item.id === hostId)),
    [computers],
  );
  const save = useCallback(async (hostId: string, directory: string | null) => {
    const saved = await window.nesvo.setDefaultSessionFolder(
      directory?.trim() || null,
      hostId,
    );
    setFolders(previous => ({ ...previous, [hostId]: saved }));
    return saved;
  }, []);
  return { folders, supported, save };
}
