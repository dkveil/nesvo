import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import type { Conflict } from './use-editor-state';

type Props = {
  conflict: Conflict | null;
  onResolve: (choice: 'reload' | 'keep') => void;
};

export function ConflictDialog({ conflict, onResolve }: Props) {
  const deleted = conflict?.response.currentHash === null;
  return (
    <Dialog open={!!conflict} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">
            {deleted ? 'File removed on disk' : 'File changed on disk'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {conflict?.kind === 'step' ? 'Step' : 'Pipeline'} "{conflict?.name}"{' '}
            {deleted
              ? 'no longer exists on disk. Your edits are kept and the next save creates the file again.'
              : 'was changed since it was opened. Nothing is merged: reload the current file and lose your edits, or keep your edits and save them on top of the new version.'}
          </DialogDescription>
        </DialogHeader>
        {conflict?.response.document && (
          <pre className="max-h-64 overflow-auto rounded-md bg-code-background px-3 py-2 font-mono text-2xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {conflict.response.document}
          </pre>
        )}
        <DialogFooter>
          {!deleted && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onResolve('reload')}
            >
              Reload
            </Button>
          )}
          <Button type="button" size="sm" onClick={() => onResolve('keep')}>
            {deleted ? 'Keep mine' : 'Keep mine on top of the new version'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
