import { useContext, useState } from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import {
  opensInViewer,
  type MessageAttachment,
  type OpenAttachmentInput,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { DropdownMenuItem, DropdownMenuLabel } from '@/shared/ui/dropdown-menu';
import { PreviewContext } from './attachment-preview-source';

const LOCAL_HOST_ID = 'local';

export const useAttachmentFileActions = (
  attachment: MessageAttachment | null,
) => {
  const source = useContext(PreviewContext);
  const [failure, setFailure] = useState('');
  const local = source?.hostId === LOCAL_HOST_ID;
  if (!attachment) return { menu: null, dialog: null };
  const run = (action: OpenAttachmentInput['action']) => {
    if (!source) return;
    source.api
      .openAttachment({
        sessionId: source.sessionId,
        id: attachment.id,
        action,
      })
      .catch((error: unknown) => setFailure(errorDetail(error)));
  };
  const menu = local ? (
    <>
      <DropdownMenuItem
        disabled={!opensInViewer(attachment.name)}
        onSelect={() => run('open')}
      >
        <ExternalLink />
        Open
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => run('reveal')}>
        <FolderOpen />
        Show in folder
      </DropdownMenuItem>
      {!opensInViewer(attachment.name) && (
        <DropdownMenuLabel className="max-w-64 text-2xs font-normal text-muted-foreground">
          Only documents, images and media open from Nesvo.
        </DropdownMenuLabel>
      )}
    </>
  ) : (
    <DropdownMenuLabel className="max-w-64 text-2xs font-normal text-muted-foreground">
      This file is stored on the computer that runs this session.
    </DropdownMenuLabel>
  );
  const dialog = (
    <Dialog open={!!failure} onOpenChange={open => !open && setFailure('')}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Could not open {attachment.name}</DialogTitle>
          <DialogDescription>{failure}</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
  return { menu, dialog };
};
