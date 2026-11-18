import { createContext } from 'react';
import type { DesktopApi, MessageAttachment } from '@nesvo/contracts';

export type PreviewSource = {
  hostId: string;
  sessionId: string;
  api: Pick<DesktopApi, 'readAttachment' | 'openAttachment'>;
};

const MAX_CACHED_PREVIEWS = 60;
const previews = new Map<string, Promise<string>>();

export const PreviewContext = createContext<PreviewSource | null>(null);

const decode = (data: string) =>
  Uint8Array.from(atob(data), char => char.charCodeAt(0));

export const loadPreview = (
  source: PreviewSource,
  attachment: MessageAttachment,
): Promise<string> => {
  const key = `${source.hostId}:${attachment.id}`;
  const cached = previews.get(key);
  if (cached) {
    previews.delete(key);
    previews.set(key, cached);
    return cached;
  }
  const loading = source.api
    .readAttachment({ id: attachment.id })
    .then(content =>
      URL.createObjectURL(
        new Blob([decode(content.data)], { type: content.mediaType }),
      ),
    );
  loading.catch(() => previews.delete(key));
  previews.set(key, loading);
  while (previews.size > MAX_CACHED_PREVIEWS) {
    const [oldest, url] = previews.entries().next().value!;
    previews.delete(oldest);
    void url.then(URL.revokeObjectURL, () => undefined);
  }
  return loading;
};
