import { useCallback, useState } from 'react';
import { attachmentLimits } from '@nesvo/contracts';
import type { PendingAttachment } from './paste-and-drop';

const EMPTY: PendingAttachment[] = [];

export const useAttachmentDrafts = () => {
  const [drafts, setDrafts] = useState<Record<string, PendingAttachment[]>>({});
  const list = useCallback((key: string) => drafts[key] ?? EMPTY, [drafts]);
  const add = useCallback((key: string, items: PendingAttachment[]) => {
    if (items.length === 0) return;
    setDrafts(previous => {
      const current = previous[key] ?? EMPTY;
      const known = new Set(current.map(item => item.attachment.id));
      return {
        ...previous,
        [key]: [
          ...current,
          ...items.filter(item => !known.has(item.attachment.id)),
        ].slice(0, attachmentLimits.perMessage),
      };
    });
  }, []);
  const remove = useCallback((key: string, ids: readonly string[]) => {
    if (ids.length === 0) return;
    setDrafts(previous => {
      const current = previous[key];
      if (!current) return previous;
      const next = current.filter(item => !ids.includes(item.attachment.id));
      return next.length === current.length
        ? previous
        : { ...previous, [key]: next };
    });
  }, []);
  return { list, add, remove };
};
