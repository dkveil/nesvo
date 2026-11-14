import { useViewport } from '@xyflow/react';
import { cn } from 'cn';
import { phaseLabels, phaseOrder } from '@/entities/pipeline';
import {
  LANE_HEIGHT_PX,
  laneTop,
  phaseTones,
  toneColor,
} from '@/entities/pipeline-graph';

const LABEL_HEIGHT_PX = 24;

export function Lanes() {
  const { y, zoom } = useViewport();
  const authorTurnTop = LANE_HEIGHT_PX * zoom + y;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      {phaseOrder.map((phase, index) => {
        const top = laneTop(phase) * zoom + y;
        const height = LANE_HEIGHT_PX * zoom;
        const labelTop = Math.min(
          Math.max(top, 0),
          top + height - LABEL_HEIGHT_PX,
        );
        return (
          <div key={phase}>
            <div
              className={cn(
                'absolute inset-x-0 border-t border-border',
                index % 2 === 1 && 'bg-accent/25',
              )}
              style={{ top, height }}
            />
            <span
              className="absolute left-3 flex h-6 items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase"
              style={{ top: labelTop + 4 }}
            >
              <span
                className="size-1.5 rounded-full"
                style={{ background: toneColor[phaseTones[phase]] }}
              />
              {phaseLabels[phase]}
            </span>
          </div>
        );
      })}
      <div
        className="absolute inset-x-0 flex h-0 items-center justify-center"
        style={{ top: authorTurnTop }}
      >
        <span className="rounded-full border border-dashed bg-background px-2 text-2xs leading-4 text-muted-foreground">
          Author turn · implementation
        </span>
      </div>
      <div
        className="absolute inset-x-0 border-t border-border"
        style={{ top: LANE_HEIGHT_PX * phaseOrder.length * zoom + y }}
      />
    </div>
  );
}
