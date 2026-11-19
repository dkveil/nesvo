import {
  useCallback,
  useEffect,
  useRef,
  type ComponentProps,
  type Ref,
} from 'react';
import { X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  PANEL_MIN_WIDTH_PX,
  usePanelWidth,
  type PanelKind,
} from '../lib/use-panel-width';
import { Panel, PanelAction, PanelHeader, Toolbar } from './panel';
import { PanelResizer } from './panel-resizer';

const compactWidth = () => PANEL_MIN_WIDTH_PX;
const diffWidth = (viewport: number) => Math.min(850, viewport * 0.46);
const wideWidth = (viewport: number) => Math.min(1000, viewport * 0.56);

const defaultWidths: Record<PanelKind, (viewport: number) => number> = {
  'files-tree': compactWidth,
  'files-editor': wideWidth,
  diff: diffWidth,
  changes: diffWidth,
  skills: viewport => (viewport >= 1600 ? 440 : 380),
  'pull-request': wideWidth,
  'pull-request-review': viewport => Math.min(820, viewport * 0.45),
  inspector: viewport => Math.min(536, viewport * 0.42),
  details: compactWidth,
  context: compactWidth,
  terminal: viewport => Math.min(576, viewport * 0.42),
  automation: diffWidth,
  'automation-editor': wideWidth,
  'workflow-editor': viewport => Math.min(536, viewport * 0.42),
  assistant: viewport => Math.min(536, viewport * 0.42),
};

type SidePanelProps = Omit<ComponentProps<typeof Panel>, 'ref'> & {
  kind: PanelKind;
  resizeLabel: string;
  focusOnOpen?: boolean;
  onEscape?: () => void;
};

export function SidePanel({
  kind,
  resizeLabel,
  className,
  focusOnOpen = false,
  onEscape,
  onKeyDown,
  children,
  ...props
}: SidePanelProps) {
  const focusRef = useRef<HTMLElement>(null);
  const { attach, style, resizing, resizer } = usePanelWidth(
    kind,
    defaultWidths[kind],
  );
  const attachPanel = useCallback(
    (element: HTMLElement | null) => {
      attach(element);
      focusRef.current = element;
    },
    [attach],
  );
  useEffect(() => {
    const panel = focusRef.current;
    if (focusOnOpen && panel && !panel.contains(document.activeElement))
      panel.focus({ preventScroll: true });
  }, [focusOnOpen]);
  return (
    <Panel
      {...props}
      data-slot="side-panel"
      ref={attachPanel}
      tabIndex={props.tabIndex ?? (focusOnOpen ? -1 : undefined)}
      onKeyDown={event => {
        onKeyDown?.(event);
        if (
          onEscape &&
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.preventDefault();
          onEscape();
        }
      }}
      style={{ ...style, ...props.style }}
      className={cn(
        'absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col border-l bg-background [--panel-edge-inset:var(--titlebar-inset-right)] min-[1200px]:relative min-[1200px]:inset-auto min-[1200px]:w-(--panel-width) min-[1200px]:shrink-0',
        'duration-slow ease-out motion-safe:animate-in motion-safe:slide-in-from-right-full',
        !resizing && 'transition-[width]',
        focusOnOpen && 'outline-none',
        className,
      )}
    >
      <PanelResizer label={resizeLabel} {...resizer} />
      {children}
    </Panel>
  );
}

export function SidePanelHeader({
  titleBar = true,
  children,
  onClose,
  closeLabel,
  closeRef,
  closeDisabled,
  ...props
}: ComponentProps<typeof PanelHeader> & {
  onClose: () => void;
  closeLabel: string;
  closeRef?: Ref<HTMLButtonElement>;
  closeDisabled?: boolean;
}) {
  return (
    <PanelHeader titleBar={titleBar} {...props}>
      {children}
      <PanelAction
        ref={closeRef}
        label={closeLabel}
        onClick={onClose}
        disabled={closeDisabled}
      >
        <X />
      </PanelAction>
    </PanelHeader>
  );
}

export function SidePanelFooter({
  className,
  ...props
}: ComponentProps<typeof Toolbar>) {
  return (
    <Toolbar
      {...props}
      bordered={false}
      className={cn('h-10 border-t px-3', className)}
    />
  );
}
