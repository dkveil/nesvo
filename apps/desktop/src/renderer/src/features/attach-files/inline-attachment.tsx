import { useState } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@/shared/ui/icon-button';
import { attachmentKind, type MessageAttachment } from '@nesvo/contracts';
import { AttachmentToken } from '@/shared/ui/attachment-token';
import { ImageLightbox } from './image-lightbox';
import { useAttachmentFileActions } from './use-attachment-file-actions';
import { useAttachmentPreview } from './use-attachment-preview';
import {
  formatBytes,
  type ComposerAttachment,
} from './use-composer-attachments';

const tokenKind = (kind: ComposerAttachment['kind']) =>
  kind === 'image' ? 'image' : 'file';

export function ComposerAttachmentToken({
  item,
  onRemove,
}: {
  item: ComposerAttachment;
  onRemove?: () => void;
}) {
  const preview = useAttachmentPreview(
    item.kind === 'image' ? item.attachment : null,
    item.previewUrl,
  );
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      <AttachmentToken
        name={item.name}
        kind={tokenKind(item.kind)}
        detail={
          item.status === 'failed' ? 'Not attached' : formatBytes(item.size)
        }
        src={preview.src}
        status={item.status}
      />
      {onRemove && (
        <IconButton
          label={`Remove ${item.name}`}
          size={20}
          onClick={onRemove}
          onKeyDown={event => event.stopPropagation()}
        >
          <X />
        </IconButton>
      )}
    </span>
  );
}

function InlineImage({ attachment }: { attachment: MessageAttachment }) {
  const preview = useAttachmentPreview(attachment);
  const [open, setOpen] = useState(false);
  const detail = preview.failed
    ? 'Preview unavailable on this computer'
    : formatBytes(attachment.size);
  return (
    <>
      <AttachmentToken
        name={attachment.name}
        detail={formatBytes(attachment.size)}
        src={preview.src}
        status={preview.failed ? 'failed' : 'ready'}
        onOpen={preview.src ? () => setOpen(true) : undefined}
        className="mx-0.5"
      />
      <ImageLightbox
        image={
          open && preview.src
            ? { name: attachment.name, src: preview.src, detail }
            : null
        }
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function InlineFile({ attachment }: { attachment: MessageAttachment }) {
  const actions = useAttachmentFileActions(attachment);
  return (
    <>
      <AttachmentToken
        name={attachment.name}
        kind="file"
        detail={formatBytes(attachment.size)}
        menu={actions.menu}
        className="mx-0.5"
      />
      {actions.dialog}
    </>
  );
}

export function InlineAttachment({
  attachment,
}: {
  attachment: MessageAttachment;
}) {
  return attachmentKind(attachment.mediaType) === 'image' ? (
    <InlineImage attachment={attachment} />
  ) : (
    <InlineFile attachment={attachment} />
  );
}
