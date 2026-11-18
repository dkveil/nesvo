import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attachmentLimits,
  attachmentMediaTypes,
  type DesktopApi,
  type MessageAttachment,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { stageImage } from './stage-image';

export type ComposerAttachment = {
  localId: string;
  name: string;
  size: number;
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'failed';
  error: string;
  attachment: MessageAttachment | null;
};

type AttachmentMap = Record<string, ComposerAttachment[]>;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const isAcceptedType = (type: string) =>
  (attachmentMediaTypes as readonly string[]).includes(type);

const fileName = (file: File) =>
  file.name.trim() || `Pasted image.${EXTENSIONS[file.type] ?? 'png'}`;

export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const imageFiles = (files: Iterable<File>) =>
  [...files].filter(file => file.type.startsWith('image/'));

export const useComposerAttachments = () => {
  const [items, setItems] = useState<AttachmentMap>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(
    () => () => {
      for (const list of Object.values(itemsRef.current))
        for (const item of list)
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );
  const change = useCallback(
    (
      key: string,
      update: (list: ComposerAttachment[]) => ComposerAttachment[],
    ) =>
      setItems(previous => {
        const next = { ...previous, [key]: update(previous[key] ?? []) };
        itemsRef.current = next;
        return next;
      }),
    [],
  );
  const notify = useCallback(
    (key: string, notice: string) =>
      setNotices(previous => ({ ...previous, [key]: notice })),
    [],
  );
  const add = useCallback(
    (key: string, api: Pick<DesktopApi, 'stageAttachment'>, files: File[]) => {
      const current = itemsRef.current[key] ?? [];
      const problems: string[] = [];
      const accepted: File[] = [];
      for (const file of files) {
        if (!isAcceptedType(file.type))
          problems.push(
            `${fileName(file)} is not a PNG, JPEG, WebP or GIF image.`,
          );
        else if (file.size > attachmentLimits.bytes)
          problems.push(`${fileName(file)} is larger than 5 MB.`);
        else if (
          current.length + accepted.length >=
          attachmentLimits.perMessage
        )
          problems.push('Attach up to 5 images per message.');
        else accepted.push(file);
      }
      notify(key, [...new Set(problems)].join(' '));
      const added = accepted.map(file => ({
        file,
        item: {
          localId: crypto.randomUUID(),
          name: fileName(file),
          size: file.size,
          previewUrl: URL.createObjectURL(file),
          status: 'uploading' as const,
          error: '',
          attachment: null,
        },
      }));
      if (!added.length) return;
      change(key, list => [...list, ...added.map(entry => entry.item)]);
      for (const { file, item } of added)
        stageImage(api, file, item.name).then(
          attachment =>
            change(key, list =>
              list.map(entry =>
                entry.localId === item.localId
                  ? { ...entry, status: 'ready', attachment }
                  : entry,
              ),
            ),
          (failure: unknown) =>
            change(key, list =>
              list.map(entry =>
                entry.localId === item.localId
                  ? {
                      ...entry,
                      status: 'failed',
                      error: `Could not attach ${item.name}. ${errorDetail(failure)}`,
                    }
                  : entry,
              ),
            ),
        );
    },
    [change, notify],
  );
  const remove = useCallback(
    (key: string, localId: string) => {
      const removed = itemsRef.current[key]?.find(
        item => item.localId === localId,
      );
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      change(key, list => list.filter(item => item.localId !== localId));
      notify(key, '');
    },
    [change, notify],
  );
  const clear = useCallback(
    (key: string, sent: readonly MessageAttachment[]) => {
      const ids = new Set(sent.map(attachment => attachment.id));
      for (const item of itemsRef.current[key] ?? [])
        if (item.attachment && ids.has(item.attachment.id) && item.previewUrl)
          URL.revokeObjectURL(item.previewUrl);
      change(key, list =>
        list.filter(item => !item.attachment || !ids.has(item.attachment.id)),
      );
      notify(key, '');
    },
    [change, notify],
  );
  const restore = useCallback(
    (key: string, attachments: readonly MessageAttachment[]) =>
      change(key, list => [
        ...list,
        ...attachments
          .filter(
            attachment =>
              !list.some(item => item.attachment?.id === attachment.id),
          )
          .map(attachment => ({
            localId: crypto.randomUUID(),
            name: attachment.name,
            size: attachment.size,
            previewUrl: null,
            status: 'ready' as const,
            error: '',
            attachment,
          })),
      ]),
    [change],
  );
  const pending = (key: string) =>
    (items[key] ?? []).some(item => item.status !== 'ready');
  const ready = (key: string) =>
    (items[key] ?? []).flatMap(item =>
      item.status === 'ready' && item.attachment ? [item.attachment] : [],
    );
  return {
    items: (key: string) => items[key] ?? [],
    notice: (key: string) => notices[key] ?? '',
    notify,
    add,
    remove,
    clear,
    restore,
    pending,
    ready,
  };
};
