import { hostKey } from '@/shared/lib/host-key';

const SESSIONS_NAV = 'aside[aria-label="Sidebar"] nav[aria-label="Sessions"]';

const sessionRows = (root: ParentNode) => [
  ...root.querySelectorAll<HTMLElement>('[data-session-id]'),
];

const rowKey = (row: HTMLElement) =>
  hostKey(row.dataset.sessionId ?? '', row.dataset.hostId);

export function sidebarSessionKeys(): string[] {
  const nav = document.querySelector(SESSIONS_NAV);
  return nav ? [...new Set(sessionRows(nav).map(rowKey))] : [];
}

export function focusSidebarSession(key: string): boolean {
  const nav = document.querySelector(SESSIONS_NAV);
  const row = nav && sessionRows(nav).find(item => rowKey(item) === key);
  if (!row) return false;
  row.focus();
  return true;
}

export function isSidebarSessionFocused(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    !!active.dataset.sessionId &&
    !!active.closest(SESSIONS_NAV)
  );
}

export function sidebarSection(index: number) {
  const nav = document.querySelector(SESSIONS_NAV);
  if (!nav) return null;
  const computers = [
    ...nav.querySelectorAll<HTMLElement>('[data-sidebar-section="computer"]'),
  ];
  const sections =
    computers.length > 1
      ? computers
      : [
          ...nav.querySelectorAll<HTMLElement>(
            '[data-sidebar-section="group"]',
          ),
        ];
  const section = sections[index];
  if (!section) return null;
  const first = sessionRows(section)[0];
  return {
    sessionKey: first ? rowKey(first) : null,
    heading: section.querySelector<HTMLElement>('button'),
  };
}
