import { useReactFlow, useViewport } from '@xyflow/react';
import { LayoutGrid, Map, Maximize, Minus, Plus } from 'lucide-react';
import { IconButton } from '@/shared/ui/icon-button';
import { ToolbarSeparator } from '@/shared/ui/panel';
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
      className="glass-popover absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-surface border p-0.5"
    >
      <IconButton label="Zoom out" onClick={() => void zoomOut()}>
        <Minus />
      </IconButton>
      <span className="w-9 text-center text-2xs text-muted-foreground tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <IconButton label="Zoom in" onClick={() => void zoomIn()}>
        <Plus />
      </IconButton>
      <IconButton
        label="Fit graph"
        onClick={() => void fitView(fitViewOptions)}
      >
        <Maximize />
      </IconButton>
      <ToolbarSeparator className="mx-0.5" />
      <IconButton label="Minimap" pressed={minimap} onClick={onToggleMinimap}>
        <Map />
      </IconButton>
      <IconButton label="Tidy up" disabled={tidyDisabled} onClick={onTidy}>
        <LayoutGrid />
      </IconButton>
    </div>
  );
}
