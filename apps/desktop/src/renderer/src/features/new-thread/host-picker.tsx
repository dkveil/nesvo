import { Cloud, Monitor, Plus } from 'lucide-react';
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
  hostId: string;
  disabled?: boolean;
  onChange: (hostId: string) => void;
  onManageComputers: () => void;
};

const statusLabels: Record<Computer['status'], string> = {
  connected: '',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  disconnected: 'Offline',
  error: 'Connection failed',
};

export function HostPicker({
  computers,
  hostId,
  disabled = false,
  onChange,
  onManageComputers,
}: Props) {
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  return (
    <DropdownMenu>
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
        className="w-60"
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
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {statusLabels[item.status] && (
                <DropdownMenuShortcut>
                  {statusLabels[item.status]}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManageComputers}>
          <Plus />
          Add to another machine
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
