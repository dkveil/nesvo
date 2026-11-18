import { useMemo, type ReactNode } from 'react';
import {
  PreviewContext,
  type PreviewSource,
} from './attachment-preview-source';

type AttachmentPreviewProviderProps = PreviewSource & { children: ReactNode };

export function AttachmentPreviewProvider({
  hostId,
  api,
  children,
}: AttachmentPreviewProviderProps) {
  const source = useMemo(() => ({ hostId, api }), [hostId, api]);
  return (
    <PreviewContext.Provider value={source}>{children}</PreviewContext.Provider>
  );
}
