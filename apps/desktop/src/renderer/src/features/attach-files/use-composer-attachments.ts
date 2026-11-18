import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attachmentByteLimit,
  attachmentKind,
  attachmentLimitMessage,
  attachmentLimits,
  type AttachmentKind,
  type DesktopApi,
  type MessageAttachment,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { AttachmentSupport } from './attachment-support';
import { stageFile } from './stage-file';

export type ComposerAttachment = {
  localId: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'failed';
  error: string;
  attachment: MessageAttachment | null;
  offset: number | null;
};

export type AttachmentPlacement = {
  offsets: Record<string, number>;
  removed: readonly string[];
};

type AttachmentMap = Record<string, ComposerAttachment[]>;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const fileName = (file: File) =>
  file.name.trim() ||
  (EXTENSIONS[file.type]
    ? `Pasted image.${EXTENSIONS[file.type]}`
    : 'Pasted file');

const expectedKind = (file: File) =>
  attachmentKind(
    file.type === '' && file.name.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : file.type,
  );

export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

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
    (
      key: string,
      api: Pick<DesktopApi, 'stageAttachment'>,
      support: AttachmentSupport,
      files: File[],
      offset: number | null = null,
    ) => {
      const current = itemsRef.current[key] ?? [];
      const problems: string[] = [];
      const accepted: File[] = [];
      for (const file of files) {
        const kind = support[expectedKind(file)];
        if (!kind.enabled)
          problems.push(`${fileName(file)} cannot be attached. ${kind.reason}`);
        else if (file.size === 0) problems.push(`${fileName(file)} is empty.`);
        else if (file.size > attachmentByteLimit(expectedKind(file)))
          problems.push(
            `${fileName(file)} is too large. ${attachmentLimitMessage(expectedKind(file))}`,
          );
        else if (
          current.length + accepted.length >=
          attachmentLimits.perMessage
        )
          problems.push(
            `Attach up to ${attachmentLimits.perMessage} files per message.`,
          );
        else accepted.push(file);
      }
      notify(key, [...new Set(problems)].join(' '));
      const added = accepted.map(file => ({
        file,
        item: {
          localId: crypto.randomUUID(),
          name: fileName(file),
          size: file.size,
          kind: expectedKind(file),
          previewUrl:
            expectedKind(file) === 'image' ? URL.createObjectURL(file) : null,
          status: 'uploading' as const,
          error: '',
          attachment: null,
          offset,
        },
      }));
      if (!added.length) return;
      change(key, list => [...list, ...added.map(entry => entry.item)]);
      for (const { file, item } of added)
        stageFile(api, file, item.name).then(
          attachment => {
            const kind = attachmentKind(attachment.mediaType);
            const allowed = support[kind];
            change(key, list =>
              list.map(entry =>
                entry.localId === item.localId
                  ? allowed.enabled
                    ? { ...entry, kind, status: 'ready', attachment }
                    : {
                        ...entry,
                        kind,
                        status: 'failed',
                        error: `Could not attach ${item.name}. ${allowed.reason}`,
                      }
                  : entry,
              ),
            );
          },
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
  const place = useCallback(
    (key: string, { offsets, removed }: AttachmentPlacement) => {
      const current = itemsRef.current[key] ?? [];
      const moved = current.some(
        item =>
          Object.hasOwn(offsets, item.localId) &&
          offsets[item.localId] !== item.offset,
      );
      if (!moved && !removed.length) return;
      for (const item of itemsRef.current[key] ?? [])
        if (removed.includes(item.localId) && item.previewUrl)
          URL.revokeObjectURL(item.previewUrl);
      change(key, list =>
        list
          .filter(item => !removed.includes(item.localId))
          .map(item =>
            Object.hasOwn(offsets, item.localId)
              ? { ...item, offset: offsets[item.localId]! }
              : item,
          ),
      );
      if (removed.length) notify(key, '');
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
          .map(({ offset, ...attachment }) => ({
            localId: crypto.randomUUID(),
            name: attachment.name,
            size: attachment.size,
            kind: attachmentKind(attachment.mediaType),
            previewUrl: null,
            status: 'ready' as const,
            error: '',
            attachment,
            offset: offset ?? null,
          })),
      ]),
    [change],
  );
  const pending = (key: string) =>
    (items[key] ?? []).some(item => item.status !== 'ready');
  const ready = (key: string) =>
    (items[key] ?? []).flatMap(item =>
      item.status === 'ready' && item.attachment
        ? [
            item.offset == null
              ? item.attachment
              : { ...item.attachment, offset: item.offset },
          ]
        : [],
    );
  return {
    items: (key: string) => items[key] ?? [],
    notice: (key: string) => notices[key] ?? '',
    notify,
    add,
    remove,
    place,
    clear,
    restore,
    pending,
    ready,
  };
};
