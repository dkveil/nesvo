import type { ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';

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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
};

export function RowActionsMenu({
  label,
  actions,
  open,
  onOpenChange,
  className,
}: Props) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={event => event.stopPropagation()}
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-sm text-sidebar-icon transition-colors duration-100 outline-none hover:bg-sidebar-row-selected hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring',
            className,
          )}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-44"
        onCloseAutoFocus={event => event.preventDefault()}
      >
        {actions.map((action, index) =>
          action === 'separator' ? (
            <DropdownMenuSeparator key={`separator-${index}`} />
          ) : (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              onSelect={action.onSelect}
              className={cn(
                action.destructive &&
                  'text-error-foreground focus:text-error-foreground [&_svg:not([class*=text-])]:text-error-foreground',
              )}
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
