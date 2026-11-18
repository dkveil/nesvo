import { useEffect, useRef } from 'react';
import type { PaletteMode } from '@/features/command-palette';
import { isComposing } from '@/shared/lib/keyboard-shortcuts';

export type WorkspaceShortcutHandlers = {
  openPalette: (mode: PaletteMode) => void;
  openHistorySearch: () => void;
  toggleSidebar: () => void;
  newSession: () => void;
  openSettings: () => void;
  openFiles: () => void;
  reviewPullRequest: () => void;
  stepSession: (direction: 1 | -1) => void;
  nextNeedsMe: () => void;
  lastSession: () => void;
  jumpToSection: (index: number) => void;
  focusComposer: () => boolean;
};

const ARROW_OWNERS =
  '[role="combobox"], [role="listbox"], [role="menu"], [role="slider"], [role="spinbutton"], [role="tree"], [role="grid"], select, input[type="number"], input[type="range"]';

const SECTION_CODE = /^Digit([1-9])$/;

const ownsAltArrows = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(ARROW_OWNERS);

const isInsidePanel = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest('[data-slot="panel"]') &&
  !target.closest('#message-input');

const modalOpen = () =>
  !!document.querySelector('[role="dialog"][aria-modal="true"]');

function primaryShortcut(
  event: KeyboardEvent,
  run: WorkspaceShortcutHandlers,
): (() => void) | null {
  const key = event.key.toLowerCase();
  const section = SECTION_CODE.exec(event.code);
  if (key === 'p')
    return () => run.openPalette(event.shiftKey ? 'all' : 'sessions');
  if (event.shiftKey) {
    if (key === 'f') return run.openHistorySearch;
    if (key === 'e') return run.openFiles;
    if (key === 'g') return run.reviewPullRequest;
    return null;
  }
  if (key === 'k') return run.openHistorySearch;
  if (key === 'b') return run.toggleSidebar;
  if (key === 'n') return run.newSession;
  if (key === ',') return run.openSettings;
  if (key === 'j') return run.nextNeedsMe;
  if (event.code === 'Backquote') return run.lastSession;
  if (section) return () => run.jumpToSection(Number(section[1]) - 1);
  return null;
}

export function useWorkspaceShortcuts(handlers: WorkspaceShortcutHandlers) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposing(event) || modalOpen()) return;
      const run = latest.current;
      if (event.key === 'Escape') {
        if (
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          isInsidePanel(event.target) &&
          run.focusComposer()
        )
          event.preventDefault();
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      ) {
        if (ownsAltArrows(event.target)) return;
        event.preventDefault();
        run.stepSession(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat)
        return;
      const action = primaryShortcut(event, run);
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
