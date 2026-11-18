import { useState } from 'react';
import { attachmentKind, type MessageAttachment } from '@nesvo/contracts';
import { AttachmentChip } from '@/shared/ui/attachment-chip';
import { useAttachmentFileActions } from './use-attachment-file-actions';
import { useAttachmentPreview } from './use-attachment-preview';
import { ImageLightbox } from './image-lightbox';
import {
  formatBytes,
  type ComposerAttachment,
} from './use-composer-attachments';

type OpenImage = { name: string; src: string; detail: string };

type PreviewChipProps = {
  name: string;
  size: number;
  kind: ComposerAttachment['kind'];
  attachment: MessageAttachment | null;
  localUrl: string | null;
  status: ComposerAttachment['status'];
  error?: string;
  chipSize: 'sm' | 'md';
  onOpen: (image: OpenImage) => void;
  onRemove?: () => void;
};

function FileChip({
  name,
  size,
  attachment,
  status,
  error,
  chipSize,
  onRemove,
}: Omit<PreviewChipProps, 'kind' | 'localUrl' | 'onOpen'>) {
  const actions = useAttachmentFileActions(onRemove ? null : attachment);
  return (
    <li>
      <AttachmentChip
        name={name}
        kind="file"
        status={status}
        detail={error || formatBytes(size)}
        size={chipSize}
        menu={actions.menu}
        onRemove={onRemove}
      />
      {actions.dialog}
    </li>
  );
}

function PreviewChip(props: PreviewChipProps) {
  return props.kind === 'image' ? (
    <ImageChip {...props} />
  ) : (
    <FileChip {...props} />
  );
}

function ImageChip({
  name,
  size,
  attachment,
  localUrl,
  status,
  error,
  chipSize,
  onOpen,
  onRemove,
}: PreviewChipProps) {
  const preview = useAttachmentPreview(attachment, localUrl);
  const detail =
    error ||
    (preview.failed
      ? 'Preview unavailable on this computer'
      : formatBytes(size));
  return (
    <li>
      <AttachmentChip
        name={name}
        src={preview.src}
        status={status === 'ready' && preview.failed ? 'failed' : status}
        detail={detail}
        size={chipSize}
        onOpen={
          preview.src
            ? () => onOpen({ name, src: preview.src!, detail })
            : undefined
        }
        onRemove={onRemove}
      />
    </li>
  );
}

type AttachmentTrayProps = {
  items: ComposerAttachment[];
  onRemove: (localId: string) => void;
};

export function AttachmentTray({ items, onRemove }: AttachmentTrayProps) {
  const [open, setOpen] = useState<OpenImage | null>(null);
  if (!items.length) return null;
  return (
    <>
      <ul
        aria-label="Attached files"
        className="mb-2 flex min-w-0 flex-wrap gap-2 pt-1.5 pr-1.5"
      >
        {items.map(item => (
          <PreviewChip
            key={item.localId}
            name={item.name}
            size={item.size}
            kind={item.kind}
            attachment={item.attachment}
            localUrl={item.previewUrl}
            status={item.status}
            error={item.error}
            chipSize="sm"
            onOpen={setOpen}
            onRemove={() => onRemove(item.localId)}
          />
        ))}
      </ul>
      <ImageLightbox image={open} onClose={() => setOpen(null)} />
    </>
  );
}

type MessageAttachmentsProps = {
  attachments: readonly MessageAttachment[];
};

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  const [open, setOpen] = useState<OpenImage | null>(null);
  return (
    <>
      <ul
        aria-label={`${attachments.length} attached ${attachments.length === 1 ? 'file' : 'files'}`}
        className="flex max-w-[85%] flex-wrap justify-end gap-2"
      >
        {attachments.map(attachment => (
          <PreviewChip
            key={attachment.id}
            name={attachment.name}
            size={attachment.size}
            kind={attachmentKind(attachment.mediaType)}
            attachment={attachment}
            localUrl={null}
            status="ready"
            chipSize="md"
            onOpen={setOpen}
          />
        ))}
      </ul>
      <ImageLightbox image={open} onClose={() => setOpen(null)} />
    </>
  );
}
