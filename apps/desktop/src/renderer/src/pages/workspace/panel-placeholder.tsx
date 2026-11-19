import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { PanelKind } from '@/shared/lib/use-panel-width';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';

type PanelPlaceholderProps = {
  kind: PanelKind;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  onClose: () => void;
};

export function PanelPlaceholder({
  kind,
  icon,
  title,
  children,
  onClose,
}: PanelPlaceholderProps) {
  return (
    <SidePanel kind={kind} resizeLabel={`Resize ${title.toLowerCase()} panel`}>
      <SidePanelHeader
        icon={icon}
        title={title}
        closeLabel={`Close ${title.toLowerCase()}`}
        onClose={onClose}
      />
      {children}
    </SidePanel>
  );
}
