import type { ReactNode } from 'react';
import { Minimize2 } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/shared/ui/dialog';
import { IconButton } from '@/shared/ui/icon-button';
import { WrapToggle } from './diff-view-toggles';

type DiffFullscreenProps = {
  path: string | null;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
};

export function DiffFullscreen({
  path,
  meta,
  onClose,
  children,
}: DiffFullscreenProps) {
  return (
    <Dialog open={!!path} onOpenChange={open => !open && onClose()}>
      <DialogContent
        placement="fullscreen"
        showCloseButton={false}
        onEscapeKeyDown={event => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-diff-comment]')
          )
            event.preventDefault();
        }}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-4">
          <DialogTitle className="min-w-0 truncate font-mono text-xs font-medium">
            {path}
          </DialogTitle>
          {meta}
          <DialogDescription className="sr-only">
            Fullscreen diff. Press Escape to return.
          </DialogDescription>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <WrapToggle />
            <DialogClose asChild>
              <IconButton label="Exit fullscreen" shortcut="Esc">
                <Minimize2 />
              </IconButton>
            </DialogClose>
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-code-background">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
