import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  PANEL_MIN_WIDTH_PX,
  usePanelWidth,
  type PanelKind,
} from '@/shared/lib/use-panel-width';
import { Panel, PanelHeader } from '@/shared/ui/panel';
import { PanelResizer } from '@/shared/ui/panel-resizer';
import { panelSurface } from '@/shared/ui/panel-styles';

const DIFF_WIDTH_RATIO = 0.46;
const DIFF_MAX_WIDTH_PX = 850;
const PULL_REQUEST_WIDTH_RATIO = 0.56;
const PULL_REQUEST_MAX_WIDTH_PX = 1000;
const REVIEW_WIDTH_RATIO = 0.45;
const REVIEW_MAX_WIDTH_PX = 820;
const WIDE_VIEWPORT_PX = 1600;
const SKILLS_WIDTH_PX = 380;
const WIDE_SKILLS_WIDTH_PX = 440;

const defaultWidths: Record<PanelKind, (viewportWidth: number) => number> = {
  diff: viewport => Math.min(DIFF_MAX_WIDTH_PX, viewport * DIFF_WIDTH_RATIO),
  'pull-request': viewport =>
    Math.min(PULL_REQUEST_MAX_WIDTH_PX, viewport * PULL_REQUEST_WIDTH_RATIO),
  'pull-request-review': viewport =>
    Math.min(REVIEW_MAX_WIDTH_PX, viewport * REVIEW_WIDTH_RATIO),
  'files-tree': () => PANEL_MIN_WIDTH_PX,
  'files-editor': () => PANEL_MIN_WIDTH_PX,
  skills: viewport =>
    viewport >= WIDE_VIEWPORT_PX ? WIDE_SKILLS_WIDTH_PX : SKILLS_WIDTH_PX,
};

type PanelPlaceholderProps = {
  kind: PanelKind;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
};

export function PanelPlaceholder({
  kind,
  icon,
  title,
  children,
}: PanelPlaceholderProps) {
  const { attach, style, resizer } = usePanelWidth(kind, defaultWidths[kind]);
  return (
    <Panel ref={attach} style={style} className={panelSurface}>
      <PanelResizer
        label={`Resize ${title.toLowerCase()} panel`}
        {...resizer}
      />
      <PanelHeader titleBar icon={icon} title={title} />
      {children}
    </Panel>
  );
}
