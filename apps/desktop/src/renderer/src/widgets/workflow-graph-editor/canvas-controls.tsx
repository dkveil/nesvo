import { useReactFlow, useViewport } from '@xyflow/react';
import { LayoutGrid, Map, Maximize, Minus, Plus } from 'lucide-react';
import { PanelAction } from '@/shared/ui/panel';
import { fitViewOptions } from './canvas-types';

type Props = {
  minimap: boolean;
  onToggleMinimap: () => void;
  onTidy: () => void;
  tidyDisabled: boolean;
};

export function CanvasControls({
  minimap,
  onToggleMinimap,
  onTidy,
  tidyDisabled,
}: Props) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div
      role="toolbar"
      aria-label="Canvas controls"
      className="absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-lg border bg-card/90 p-0.5 shadow-(--popover-shadow) backdrop-blur"
    >
      <PanelAction aria-label="Zoom out" onClick={() => void zoomOut()}>
        <Minus />
      </PanelAction>
      <span className="w-9 text-center text-2xs text-muted-foreground tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <PanelAction aria-label="Zoom in" onClick={() => void zoomIn()}>
        <Plus />
      </PanelAction>
      <PanelAction
        aria-label="Fit graph"
        title="Fit view"
        onClick={() => void fitView(fitViewOptions)}
      >
        <Maximize />
      </PanelAction>
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
      <PanelAction
        aria-label="Minimap"
        aria-pressed={minimap}
        title="Toggle the minimap"
        onClick={onToggleMinimap}
      >
        <Map />
      </PanelAction>
      <PanelAction
        aria-label="Tidy up"
        title="Tidy up the layout"
        disabled={tidyDisabled}
        onClick={onTidy}
      >
        <LayoutGrid />
      </PanelAction>
    </div>
  );
}
