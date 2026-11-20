import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';

type DrawerHost = {
  element: HTMLDivElement | null;
  register: (drawer: { close: () => void; dismiss: () => void }) => () => void;
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
  resizeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
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
    onClose();
    trigger?.focus();
  };
  useEffect(() => register?.({ close, dismiss: onClose }));

  if (!host?.element) return null;
  return createPortal(
    <SidePanel
      aria-label={title}
      kind="details"
      resizeLabel={resizeLabel}
      focusOnOpen
      className="pointer-events-auto"
    >
      <SidePanelHeader
        title={
          <span className="block leading-4 whitespace-normal">{title}</span>
        }
        closeLabel={closeLabel}
        onClose={close}
      />
      {children}
    </SidePanel>,
    host.element,
  );
}
