import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
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
          <DialogTitle>
            {deleted ? 'File removed on disk' : 'File changed on disk'}
          </DialogTitle>
          <DialogDescription>
            {conflict?.kind === 'step' ? 'Step' : 'Workflow'} "{conflict?.name}"{' '}
            {deleted
              ? 'no longer exists on disk. Your edits are kept and the next save creates the file again.'
              : 'was changed since it was opened. Nothing is merged: reload the current file and lose your edits, or keep your edits and save them on top of the new version.'}
          </DialogDescription>
        </DialogHeader>
        {conflict?.response.document && (
          <CodeBlock
            code={conflict.response.document}
            wrap
            maxHeightClassName="max-h-64"
          />
        )}
        <DialogFooter>
          {!deleted && (
            <Button
              type="button"
              variant="outline"
              size="md"
              onClick={() => onResolve('reload')}
            >
              Reload
            </Button>
          )}
          <Button type="button" size="md" onClick={() => onResolve('keep')}>
            {deleted ? 'Keep mine' : 'Keep mine on top of the new version'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
