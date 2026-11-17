import type { MessageAttachment } from '@nesvo/contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { formatBytes } from './paste-and-drop';
import type { AttachmentContent } from './use-attachment-content';

type Props = {
  attachment: MessageAttachment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: AttachmentContent | null;
  error: string;
};

export const AttachmentPreview = ({
  attachment,
  open,
  onOpenChange,
  content,
  error,
}: Props) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle className="truncate pr-6 text-base">
          {attachment.name}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {attachment.mediaType} · {formatBytes(attachment.bytes)}
        </DialogDescription>
      </DialogHeader>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !content ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading attachment…
        </p>
      ) : content.kind === 'image' ? (
        <img
          src={content.url}
          alt={attachment.name}
          className="mx-auto max-h-[70vh] max-w-full rounded-md object-contain"
        />
      ) : (
        <pre className="min-h-0 overflow-auto rounded-md bg-code-background px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {content.text}
        </pre>
      )}
    </DialogContent>
  </Dialog>
);
