import { Monitor, Plus } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import {
  DefaultFolderField,
  type DefaultSessionFolders,
} from '@/features/default-session-folder';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  computer: Computer | undefined;
  defaultFolders: DefaultSessionFolders;
  onAddComputer: () => void;
};

export function ComputersStep({
  computer,
  defaultFolders,
  onAddComputer,
}: Props) {
  const hostId = computer?.id ?? 'local';
  const name = computer?.name ?? 'Local';
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-surface border bg-card px-3 py-3">
        <div className="flex items-center gap-3">
          <Monitor
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
          <p className="min-w-0 flex-1 truncate text-ui font-medium">{name}</p>
          <StatusMessage
            tone={computer?.status === 'connected' ? 'success' : 'loading'}
          >
            {computer?.status === 'connected' ? 'Ready' : 'Connecting…'}
          </StatusMessage>
        </div>
        <DefaultFolderField
          key={`${hostId}:${defaultFolders.folders[hostId] ?? ''}`}
          id="onboarding-default-folder"
          computerName={name}
          value={defaultFolders.folders[hostId] ?? null}
          supported={defaultFolders.supported(hostId)}
          onSave={directory => defaultFolders.save(hostId, directory)}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-muted-foreground">
          Optional: run sessions on a Linux server over SSH. Its sessions, files
          and provider accounts stay there.
        </p>
        <Button variant="ghost" size="sm" onClick={onAddComputer}>
          <Plus />
          Add a computer
        </Button>
      </div>
    </div>
  );
}
