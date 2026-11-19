import type { Computer, DesktopApi } from '@nesvo/contracts';
import type { DefaultSessionFolders } from '@/features/default-session-folder';
import { ManageComputers } from '@/features/manage-computers';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  computers: Computer[];
  defaultFolders: DefaultSessionFolders;
  api: DesktopApi;
  error: string;
  onEditingChange: (editing: boolean) => void;
};

export function ComputersStep({
  computers,
  defaultFolders,
  api,
  error,
  onEditingChange,
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
        onEditingChange={onEditingChange}
        computers={computers}
        defaultFolders={defaultFolders}
        onboarding
      />
    </div>
  );
}
