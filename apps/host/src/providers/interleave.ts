export type PlacedItem = { offset?: number };

export type InterleavedPart<T extends PlacedItem> =
  { type: 'text'; text: string } | { type: 'item'; item: T };

export function shiftPlacement<T extends PlacedItem>(
  items: readonly T[],
  by: number,
): T[] {
  return items.map(item =>
    item.offset == null ? item : { ...item, offset: item.offset + by },
  );
}

export function interleave<T extends PlacedItem>(
  text: string,
  items: readonly T[],
): InterleavedPart<T>[] {
  const placed = items
    .map((item, index) => ({
      item,
      index,
      at: Math.min(Math.max(item.offset ?? text.length, 0), text.length),
    }))
    .sort((left, right) => left.at - right.at || left.index - right.index);
  const parts: InterleavedPart<T>[] = [];
  const pushText = (segment: string) => {
    if (segment.trim()) parts.push({ type: 'text', text: segment });
  };
  let cursor = 0;
  for (const { item, at } of placed) {
    pushText(text.slice(cursor, at));
    parts.push({ type: 'item', item });
    cursor = at;
  }
  pushText(text.slice(cursor));
  return parts;
}
