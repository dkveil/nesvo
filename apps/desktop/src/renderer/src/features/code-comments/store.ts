import { useSyncExternalStore } from 'react';
import { codeCommentLimits, type CodeComment } from '@nesvo/contracts';

export type PendingCodeComment = {
  comment: Omit<CodeComment, 'offset'>;
  offset: number | null;
};

export type CodeCommentPlacement = {
  offsets: Record<string, number>;
  removed: readonly string[];
};

type CommentMap = Record<string, readonly PendingCodeComment[]>;

const EMPTY: readonly PendingCodeComment[] = [];
const listeners = new Set<() => void>();
let state: CommentMap = {};

const change = (
  key: string,
  update: (
    list: readonly PendingCodeComment[],
  ) => readonly PendingCodeComment[],
) => {
  const current = state[key] ?? EMPTY;
  const next = update(current);
  if (next === current) return;
  state = { ...state, [key]: next };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useCodeComments = (key: string) =>
  useSyncExternalStore(subscribe, () => state[key] ?? EMPTY);

export const codeCommentCount = (key: string) => (state[key] ?? EMPTY).length;

export const addCodeComment = (
  key: string,
  comment: Omit<CodeComment, 'offset'>,
): boolean => {
  if (codeCommentCount(key) >= codeCommentLimits.perMessage) return false;
  change(key, list => [...list, { comment, offset: null }]);
  return true;
};

export const removeCodeComment = (key: string, id: string) =>
  change(key, list => list.filter(item => item.comment.id !== id));

export const placeCodeComments = (
  key: string,
  { offsets, removed }: CodeCommentPlacement,
) =>
  change(key, list => {
    const moved = list.some(
      item =>
        Object.hasOwn(offsets, item.comment.id) &&
        offsets[item.comment.id] !== item.offset,
    );
    const dropped = list.some(item => removed.includes(item.comment.id));
    if (!moved && !dropped) return list;
    return list
      .filter(item => !removed.includes(item.comment.id))
      .map(item =>
        Object.hasOwn(offsets, item.comment.id)
          ? { ...item, offset: offsets[item.comment.id]! }
          : item,
      );
  });

export const shiftCodeComments = (key: string, removedCharacters: number) =>
  change(key, list =>
    removedCharacters
      ? list.map(item =>
          item.offset == null
            ? item
            : {
                ...item,
                offset: Math.max(0, item.offset - removedCharacters),
              },
        )
      : list,
  );

export const readyCodeComments = (
  key: string,
  leadingCharacters: number,
  textLength: number,
): CodeComment[] =>
  (state[key] ?? EMPTY).map(({ comment, offset }) => ({
    ...comment,
    offset: Math.min(
      Math.max((offset ?? Number.MAX_SAFE_INTEGER) - leadingCharacters, 0),
      textLength,
    ),
  }));

export const clearCodeComments = (
  key: string,
  sent: readonly CodeComment[],
) => {
  const ids = new Set(sent.map(comment => comment.id));
  change(key, list => list.filter(item => !ids.has(item.comment.id)));
};

export const restoreCodeComments = (
  key: string,
  comments: readonly CodeComment[],
) =>
  change(key, list => [
    ...list,
    ...comments
      .filter(comment => !list.some(item => item.comment.id === comment.id))
      .map(({ offset, ...comment }) => ({ comment, offset: offset ?? null })),
  ]);
