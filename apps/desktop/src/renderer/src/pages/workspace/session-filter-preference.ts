import { sessionFilters, type SessionFilter } from '@/entities/session';

const key = 'nesvo.sidebar-filter.v1';

const isSessionFilter = (value: string | null): value is SessionFilter =>
  sessionFilters.some(filter => filter === value);

export function readSessionFilter(): SessionFilter {
  try {
    const value = localStorage.getItem(key);
    return isSessionFilter(value) ? value : 'all';
  } catch {
    return 'all';
  }
}

export function saveSessionFilter(filter: SessionFilter): void {
  try {
    localStorage.setItem(key, filter);
  } catch {
    return;
  }
}
