export const MAX_LOADED_JOBS = 64;
export const MAX_LOADED_OCCURRENCES = 64;

type Identified = { id: string };

export type PagedList<T extends Identified> = {
  items: T[];
  nextPage: number | null;
  lastPage: number;
};
export type ReceivedPage<T extends Identified> = {
  items: T[];
  page: number;
  nextPage: number | null;
};

export const mergePage = <T extends Identified>(
  current: T[],
  incoming: T[],
  replace: boolean,
  limit: number,
) => {
  if (replace) return incoming.slice(0, limit);
  const incomingIds = new Set(incoming.map(item => item.id));
  return [...current.filter(item => !incomingIds.has(item.id)), ...incoming].slice(0, limit);
};

export const nextLoadablePage = (nextPage: number | null, loaded: number, limit: number) =>
  loaded >= limit ? null : nextPage;

export const applyPage = <T extends Identified>(
  current: PagedList<T>,
  received: ReceivedPage<T>,
  replace: boolean,
  limit: number,
): PagedList<T> => {
  const items = mergePage(current.items, received.items, replace, limit);
  const furthest = replace || received.page >= current.lastPage;
  return {
    items,
    nextPage: nextLoadablePage(
      furthest ? received.nextPage : current.nextPage,
      items.length,
      limit,
    ),
    lastPage: furthest ? received.page : current.lastPage,
  };
};
