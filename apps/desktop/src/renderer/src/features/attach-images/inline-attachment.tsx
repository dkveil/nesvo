import { useState } from 'react';
import type { MessageAttachment } from '@nesvo/contracts';
import { AttachmentToken } from '@/shared/ui/attachment-token';
import { ImageLightbox } from './image-lightbox';
import { useAttachmentPreview } from './use-attachment-preview';
import {
  formatBytes,
  type ComposerAttachment,
} from './use-composer-attachments';

export function ComposerAttachmentToken({
  item,
}: {
  item: ComposerAttachment;
}) {
  const preview = useAttachmentPreview(item.attachment, item.previewUrl);
  return (
    <AttachmentToken
      name={item.name}
      detail={
        item.status === 'failed' ? 'Not attached' : formatBytes(item.size)
      }
      src={preview.src}
      status={item.status}
    />
  );
}

export function InlineAttachment({
  attachment,
}: {
  attachment: MessageAttachment;
}) {
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
