export const MAX_LINEAGE_DEPTH = 3;

type LineageNode = { id: string; parentSessionId?: string | null };
export type LineageRow<T extends LineageNode> = { session: T; root: T; depth: number };

export const sessionLineageRows = <T extends LineageNode>(sessions: T[]): LineageRow<T>[] => {
  const ids = new Set(sessions.map(session => session.id));
  const children = new Map<string, T[]>();
  for (const session of sessions) {
    const parent = session.parentSessionId;
    if (!parent || parent === session.id || !ids.has(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), session]);
  }
  const rows: LineageRow<T>[] = [];
  const placed = new Set<string>();
  const place = (session: T, root: T, depth: number) => {
    if (placed.has(session.id)) return;
    placed.add(session.id);
    rows.push({ session, root, depth: Math.min(depth, MAX_LINEAGE_DEPTH) });
    for (const child of children.get(session.id) ?? []) place(child, root, depth + 1);
  };
  const isRoot = (session: T) =>
    !session.parentSessionId ||
    session.parentSessionId === session.id ||
    !ids.has(session.parentSessionId);
  for (const session of sessions) if (isRoot(session)) place(session, session, 0);
  for (const session of sessions) place(session, session, 0);
  return rows;
};
