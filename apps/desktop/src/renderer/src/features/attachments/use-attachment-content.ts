import { useEffect, useState } from 'react';
import type {
  MessageAttachment,
  ReadAttachmentInput,
  StagedAttachment,
} from '@nesvo/contracts';
import { decodeText, previewUrl } from './paste-and-drop';

export type AttachmentReader = (
  input: ReadAttachmentInput,
) => Promise<StagedAttachment>;

export type AttachmentContent =
  { kind: 'image'; url: string } | { kind: 'text'; text: string };

type ContentState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; content: AttachmentContent }
  | { status: 'error'; error: string };

const CACHE_LIMIT = 20;
const CONCURRENT_READS = 2;
const cache = new Map<string, AttachmentContent>();
const inflight = new Map<string, Promise<AttachmentContent>>();
const waiting: Array<() => void> = [];
let reading = 0;

const remember = (key: string, content: AttachmentContent) => {
  cache.delete(key);
  cache.set(key, content);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

const withSlot = async <T>(task: () => Promise<T>): Promise<T> => {
  if (reading >= CONCURRENT_READS)
    await new Promise<void>(resolve => waiting.push(resolve));
  reading++;
  try {
    return await task();
  } finally {
    reading--;
    waiting.shift()?.();
  }
};

const contentKey = (hostId: string, sessionId: string, id: string) =>
  `${hostId}/${sessionId}/${id}`;

export const cachedAttachment = (
  hostId: string,
  sessionId: string,
  id: string,
): AttachmentContent | undefined => {
  const key = contentKey(hostId, sessionId, id);
  const content = cache.get(key);
  if (content) remember(key, content);
  return content;
};

export const loadAttachment = (
  read: AttachmentReader,
  hostId: string,
  sessionId: string,
  attachment: MessageAttachment,
): Promise<AttachmentContent> => {
  const key = contentKey(hostId, sessionId, attachment.id);
  const cached = cachedAttachment(hostId, sessionId, attachment.id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const loading = withSlot(() =>
    read({ sessionId, attachmentId: attachment.id }),
  )
    .then(({ attachment: stored, data }): AttachmentContent => {
      const content: AttachmentContent =
        stored.kind === 'image'
          ? { kind: 'image', url: previewUrl(stored, data) }
          : { kind: 'text', text: decodeText(data) };
      remember(key, content);
      return content;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, loading);
  return loading;
};

export const useAttachmentContent = ({
  read,
  hostId,
  sessionId,
  attachment,
  enabled,
}: {
  read: AttachmentReader;
  hostId: string;
  sessionId: string;
  attachment: MessageAttachment;
  enabled: boolean;
}): ContentState => {
  const key = contentKey(hostId, sessionId, attachment.id);
  const cached = cachedAttachment(hostId, sessionId, attachment.id);
  const [settled, setSettled] = useState<{
    key: string;
    state: ContentState;
  } | null>(null);
  useEffect(() => {
    if (!enabled || cached) return;
    let current = true;
    loadAttachment(read, hostId, sessionId, attachment).then(
      content =>
        current && setSettled({ key, state: { status: 'ready', content } }),
      (failure: unknown) =>
        current &&
        setSettled({
          key,
          state: {
            status: 'error',
            error:
              failure instanceof Error
                ? failure.message
                : 'The attachment could not be loaded.',
          },
        }),
    );
    return () => {
      current = false;
    };
  }, [enabled, cached, read, hostId, sessionId, attachment, key]);
  if (cached) return { status: 'ready', content: cached };
  if (settled?.key === key) return settled.state;
  return { status: enabled ? 'loading' : 'idle' };
};
