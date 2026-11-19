import type { ReactNode, Ref } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { IconButton } from '@/shared/ui/icon-button';

export type RowAction =
  | {
      label: string;
      icon: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      destructive?: boolean;
    }
  | 'separator';

type Props = {
  label: string;
  actions: RowAction[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  headerSize?: 24 | 32;
  triggerRef?: Ref<HTMLButtonElement>;
};

export function RowActionsMenu({
  label,
  actions,
  open,
  onOpenChange,
  headerSize,
  triggerRef,
}: Props) {
  const header = headerSize !== undefined;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton
          ref={triggerRef}
          label={label}
          size={headerSize ?? 20}
          tone={header ? undefined : 'sidebar'}
          tooltipSide="bottom"
        >
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={header ? 'end' : 'start'}
        className="min-w-44"
        onCloseAutoFocus={header ? undefined : event => event.preventDefault()}
      >
        {actions.map((action, index) =>
          action === 'separator' ? (
            <DropdownMenuSeparator key={`separator-${index}`} />
          ) : (
            <DropdownMenuItem
              key={action.label}
              variant={action.destructive ? 'destructive' : 'default'}
              disabled={action.disabled}
              onSelect={action.onSelect}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
