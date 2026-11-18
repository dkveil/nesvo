import { Cloud, Import, Monitor, Plus } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { ComposerChip } from './composer-chip';

type Props = {
  computers: Computer[];
  defaultFolders?: Readonly<Record<string, string | null>>;
  hostId: string;
  disabled?: boolean;
  onChange: (hostId: string) => void;
  onManageComputers: () => void;
  onImportConversation?: () => void;
};

const statusLabels: Record<Computer['status'], string> = {
  connected: '',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  disconnected: 'Offline',
  incompatible: 'Update required',
  error: 'Connection failed',
};

export function HostPicker({
  computers,
  defaultFolders = {},
  hostId,
  disabled = false,
  onChange,
  onManageComputers,
  onImportConversation,
}: Props) {
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  return (
    <DropdownMenu modal={!onImportConversation}>
      <DropdownMenuTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Run on"
          icon={<Monitor aria-hidden="true" />}
        >
          <span>{computer?.name ?? 'Local'}</span>
          {!connected && (
            <span className="shrink-0">
              · {statusLabels[computer?.status ?? 'disconnected'] || 'Offline'}
            </span>
          )}
        </ComposerChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        collisionPadding={12}
        aria-label="Run on"
        className="w-72"
      >
        <DropdownMenuLabel>Run on</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Computer"
          value={hostId}
          onValueChange={onChange}
        >
          {computers.map(item => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              {item.id === 'local' ? <Monitor /> : <Cloud />}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.name}</span>
                {defaultFolders[item.id] && (
                  <span className="block truncate font-mono text-2xs text-muted-foreground">
                    {defaultFolders[item.id]}
                  </span>
                )}
              </span>
              {statusLabels[item.status] && (
                <DropdownMenuShortcut>
                  {statusLabels[item.status]}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {onImportConversation && (
          <DropdownMenuItem onSelect={onImportConversation}>
            <Import />
            Import conversation…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onManageComputers}>
          <Plus />
          Add to another machine
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
