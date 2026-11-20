import { useLayoutEffect, useState, type CSSProperties } from 'react';

const PANEL_KINDS = [
  'files-tree',
  'child-work',
  'files-editor',
  'diff',
  'skills',
  'pull-request',
  'pull-request-review',
  'changes',
  'inspector',
  'details',
  'context',
  'terminal',
  'automation',
  'automation-editor',
  'assistant',
] as const;

export type PanelKind = (typeof PANEL_KINDS)[number];

type StoredWidths = Partial<Record<PanelKind, number>>;

export const PANEL_MIN_WIDTH_PX = 320;
const CHAT_MIN_WIDTH_PX = 420;
const VIEWPORT_MAX_RATIO = 0.75;
const STORAGE_PREFIX = 'nesvo.panel-width.v1.';

const storageKey = (kind: PanelKind) => `${STORAGE_PREFIX}${kind}`;

function readPanelWidth(kind: PanelKind): number | null {
  try {
    const stored = Number(localStorage.getItem(storageKey(kind)));
    return stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

function readStoredWidths(): StoredWidths {
  const widths: StoredWidths = {};
  for (const kind of PANEL_KINDS) {
    const width = readPanelWidth(kind);
    if (width) widths[kind] = width;
  }
  return widths;
}

function savePanelWidth(kind: PanelKind, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(storageKey(kind));
    else localStorage.setItem(storageKey(kind), String(width));
  } catch {
    return;
  }
}

export function panelMaxWidth(sharedWidth: number) {
  return Math.max(
    PANEL_MIN_WIDTH_PX,
    Math.floor(
      Math.min(
        window.innerWidth * VIEWPORT_MAX_RATIO,
        sharedWidth - CHAT_MIN_WIDTH_PX,
      ),
    ),
  );
}

const clampPanelWidth = (width: number, sharedWidth: number) =>
  Math.round(
    Math.min(panelMaxWidth(sharedWidth), Math.max(PANEL_MIN_WIDTH_PX, width)),
  );

const isInFlow = (element: Element) => {
  const style = getComputedStyle(element);
  return style.position !== 'absolute' && style.position !== 'fixed';
};

function sharedWidthOf(panel: HTMLElement) {
  const row = panel.parentElement;
  if (!row) return window.innerWidth;
  let shared = panel.getBoundingClientRect().width;
  for (const sibling of row.children)
    if (
      sibling !== panel &&
      isInFlow(sibling) &&
      getComputedStyle(sibling).flexGrow !== '0'
    )
      shared += sibling.getBoundingClientRect().width;
  return shared;
}

export type PanelResizerProps = {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
  onDraggingChange: (dragging: boolean) => void;
};

type UsePanelWidthResult = {
  attach: (element: HTMLElement | null) => void;
  style: CSSProperties;
  resizing: boolean;
  resizer: PanelResizerProps;
};

export function usePanelWidth(
  kind: PanelKind,
  defaultWidth: (viewportWidth: number) => number,
): UsePanelWidthResult {
  const [stored, setStored] = useState<StoredWidths>(readStoredWidths);
  const [sharedWidth, setSharedWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const row = panel?.parentElement;
    if (!panel || !row) return;
    const measure = () => setSharedWidth(sharedWidthOf(panel));
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    for (const child of row.children) observer.observe(child);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [panel]);
  const preferred = stored[kind] ?? defaultWidth(window.innerWidth);
  const width = clampPanelWidth(preferred, sharedWidth);
  const update = (next: number | null) => {
    setStored(previous => {
      const copy = { ...previous };
      if (next === null) delete copy[kind];
      else copy[kind] = next;
      return copy;
    });
    savePanelWidth(kind, next);
  };
  return {
    attach: setPanel,
    style: { '--panel-width': `${width}px` } as CSSProperties,
    resizing,
    resizer: {
      width,
      min: PANEL_MIN_WIDTH_PX,
      max: panelMaxWidth(sharedWidth),
      onResize: next => update(clampPanelWidth(next, sharedWidth)),
      onReset: () => update(null),
      onDraggingChange: setResizing,
    },
  };
}
