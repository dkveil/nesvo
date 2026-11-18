import type { Computer, DesktopApi } from '@nesvo/contracts';
import type { DefaultSessionFolders } from '@/features/default-session-folder';
import { ManageComputers } from '@/features/manage-computers';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  computers: Computer[];
  defaultFolders: DefaultSessionFolders;
  api: DesktopApi;
  error: string;
};

export function ComputersStep({
  computers,
  defaultFolders,
  api,
  error,
}: Props) {
  return (
    <div className="space-y-3">
      {error && (
        <StatusMessage tone="error" variant="notice">
          {error}
        </StatusMessage>
      )}
      {!computers.length && !error && (
        <StatusMessage tone="loading">Connecting to Local…</StatusMessage>
      )}
      <ManageComputers
        api={api}
        computers={computers}
        defaultFolders={defaultFolders}
        chooseLocalDirectory={api.chooseDirectory}
      />
    </div>
  );
}
