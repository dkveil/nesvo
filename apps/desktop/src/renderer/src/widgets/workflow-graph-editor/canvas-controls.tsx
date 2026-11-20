import { useReactFlow, useViewport } from '@xyflow/react';
import { LayoutGrid, Map } from 'lucide-react';
import { IconButton } from '@/shared/ui/icon-button';
import { ToolbarSeparator } from '@/shared/ui/panel';
import { ZoomControls } from '@/shared/ui/zoom-controls';

type Props = {
  onFit: () => void;
  minimap?: boolean;
  onToggleMinimap?: () => void;
  onTidy?: () => void;
  tidyDisabled?: boolean;
};

export function CanvasControls({
  onFit,
  minimap,
  onToggleMinimap,
  onTidy,
  tidyDisabled,
}: Props) {
  const { zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div
      role="toolbar"
      aria-label="Canvas controls"
      className="glass-popover absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-surface border p-0.5"
    >
      <ZoomControls
        zoom={zoom}
        onZoomOut={() => void zoomOut()}
        onZoomIn={() => void zoomIn()}
        onFit={onFit}
      />
      {(onToggleMinimap || onTidy) && <ToolbarSeparator className="mx-0.5" />}
      {onToggleMinimap && (
        <IconButton label="Minimap" pressed={minimap} onClick={onToggleMinimap}>
          <Map />
        </IconButton>
      )}
      {onTidy && (
        <IconButton label="Tidy up" disabled={tidyDisabled} onClick={onTidy}>
          <LayoutGrid />
        </IconButton>
      )}
    </div>
  );
}
