import { useEffect, useRef, useState } from 'react';
import type { MessageAttachment } from '@nesvo/contracts';
import { AttachmentChip } from './attachment-chip';
import { AttachmentPreview } from './attachment-preview';
import { decodeText } from './paste-and-drop';
import {
  useAttachmentContent,
  type AttachmentContent,
  type AttachmentReader,
} from './use-attachment-content';

type Props = {
  attachment: MessageAttachment;
  hostId: string;
  sessionId: string;
  read: AttachmentReader;
  data?: string | null;
  preview?: string | null;
  onRemove?: () => void;
  className?: string;
};

const localContent = (
  attachment: MessageAttachment,
  data: string | null | undefined,
  preview: string | null | undefined,
): AttachmentContent | null => {
  if (attachment.kind === 'image' && preview)
    return { kind: 'image', url: preview };
  if (attachment.kind === 'text' && data)
    return { kind: 'text', text: decodeText(data) };
  return null;
};

const useVisible = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
};

export const AttachmentItem = ({
  attachment,
  hostId,
  sessionId,
  read,
  data,
  preview,
  onRemove,
  className,
}: Props) => {
  const [open, setOpen] = useState(false);
  const { ref, visible } = useVisible();
  const local = open
    ? localContent(attachment, data, preview)
    : attachment.kind === 'image' && preview
      ? { kind: 'image' as const, url: preview }
      : null;
  const remote = useAttachmentContent({
    read,
    hostId,
    sessionId,
    attachment,
    enabled: !local && (open || (attachment.kind === 'image' && visible)),
  });
  const content = local ?? (remote.status === 'ready' ? remote.content : null);
  return (
    <>
      <AttachmentChip
        ref={ref}
        attachment={attachment}
        thumbnail={content?.kind === 'image' ? content.url : null}
        onOpen={() => setOpen(true)}
        onRemove={onRemove}
        className={className}
      />
      {open && (
        <AttachmentPreview
          attachment={attachment}
          open={open}
          onOpenChange={setOpen}
          content={content}
          error={remote.status === 'error' ? remote.error : ''}
        />
      )}
    </>
  );
};
