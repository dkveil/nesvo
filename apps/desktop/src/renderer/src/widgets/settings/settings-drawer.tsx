import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import type { Drawer } from './use-settings-drawer';

type DrawerHost = {
  element: HTMLDivElement | null;
  register: (drawer: Drawer) => () => void;
};

const DrawerContext = createContext<DrawerHost | null>(null);

export function SettingsDrawerHost({
  children,
  ...host
}: DrawerHost & { children: ReactNode }) {
  return (
    <DrawerContext.Provider value={host}>{children}</DrawerContext.Provider>
  );
}

export function SettingsDrawer({
  title,
  closeLabel,
  closeDisabled,
  kind = 'details',
  icon,
  meta,
  resizeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  closeDisabled?: boolean;
  kind?: ComponentProps<typeof SidePanel>['kind'];
  icon?: ComponentProps<typeof SidePanelHeader>['icon'];
  meta?: ReactNode;
  resizeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const host = useContext(DrawerContext);
  const register = host?.register;
  const [trigger] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const close = () => {
    if (closeDisabled) return;
    onClose();
    trigger?.focus();
  };
  useEffect(() => register?.({ close, dismiss: onClose }));

  if (!host?.element) return null;
  return createPortal(
    <SidePanel
      aria-label={title}
      kind={kind}
      resizeLabel={resizeLabel}
      focusOnOpen
      onEscape={close}
      className="pointer-events-auto"
    >
      <SidePanelHeader
        title={
          <span className="block leading-4 whitespace-normal">{title}</span>
        }
        closeLabel={closeLabel}
        icon={icon}
        meta={meta}
        closeDisabled={closeDisabled}
        onClose={close}
      />
      {children}
    </SidePanel>,
    host.element,
  );
}
