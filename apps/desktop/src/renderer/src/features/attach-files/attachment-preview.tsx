import { useMemo, type ReactNode } from 'react';
import {
  PreviewContext,
  type PreviewSource,
} from './attachment-preview-source';

type AttachmentPreviewProviderProps = PreviewSource & { children: ReactNode };

export function AttachmentPreviewProvider({
  hostId,
  sessionId,
  api,
  children,
}: AttachmentPreviewProviderProps) {
  const source = useMemo(
    () => ({ hostId, sessionId, api }),
    [hostId, sessionId, api],
  );
  return (
    <PreviewContext.Provider value={source}>{children}</PreviewContext.Provider>
  );
}
