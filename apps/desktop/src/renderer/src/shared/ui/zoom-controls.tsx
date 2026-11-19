import { Maximize, Minus, Plus } from 'lucide-react';
import { IconButton } from '@/shared/ui/icon-button';

export function ZoomControls({
  zoom,
  onZoomOut,
  onZoomIn,
  onFit,
  fitLabel = 'Fit graph',
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  fitLabel?: string;
}) {
  return (
    <>
      <IconButton label="Zoom out" onClick={onZoomOut}>
        <Minus />
      </IconButton>
      <span className="w-9 text-center text-2xs text-muted-foreground tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <IconButton label="Zoom in" onClick={onZoomIn}>
        <Plus />
      </IconButton>
      <IconButton label={fitLabel} onClick={onFit}>
        <Maximize />
      </IconButton>
    </>
  );
}
