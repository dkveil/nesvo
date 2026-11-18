import { useContext, useEffect, useState } from 'react';
import type { MessageAttachment } from '@nesvo/contracts';
import { PreviewContext, loadPreview } from './attachment-preview-source';

export const useAttachmentPreview = (
  attachment: MessageAttachment | null,
  localUrl: string | null = null,
) => {
  const source = useContext(PreviewContext);
  const [state, setState] = useState<{
    id: string;
    src: string | null;
    failed: boolean;
  } | null>(null);
  const id = attachment?.id ?? '';
  useEffect(() => {
    if (localUrl || !attachment || !source) return;
    let active = true;
    loadPreview(source, attachment).then(
      src => active && setState({ id: attachment.id, src, failed: false }),
      () => active && setState({ id: attachment.id, src: null, failed: true }),
    );
    return () => {
      active = false;
    };
  }, [attachment, id, localUrl, source]);
  if (localUrl) return { src: localUrl, failed: false };
  return state?.id === id
    ? { src: state.src, failed: state.failed }
    : { src: null, failed: false };
};
