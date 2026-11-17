import { ViewportPortal } from '@xyflow/react';
import { phaseLabels } from '@/entities/workflow';
import {
  phaseFrames,
  phaseTones,
  type EditorNode,
  type PhaseFrame,
} from '@/entities/workflow-graph';
import { Badge } from '@/shared/ui/badge';
import { StatusDot } from '@/shared/ui/status-dot';
import { dotTones } from './tone-dot';

type Props = { nodes: readonly EditorNode[] };

const authorTurn = (frames: PhaseFrame[]) => {
  const plan = frames.find(frame => frame.phase === 'plan');
  const next = frames.find(frame => frame.phase !== 'plan');
  if (!plan || !next || next.x <= plan.x + plan.width) return null;
  const x = (plan.x + plan.width + next.x) / 2;
  const top = Math.min(plan.y, next.y);
  const bottom = Math.max(plan.y + plan.height, next.y + next.height);
  return { x, top, height: bottom - top };
};

export function PhaseFrames({ nodes }: Props) {
  const frames = phaseFrames(nodes);
  const turn = authorTurn(frames);
  return (
    <ViewportPortal>
      {frames.map(frame => (
        <div
          key={frame.phase}
          aria-hidden="true"
          data-phase-frame={frame.phase}
          className="pointer-events-none absolute rounded-composer border border-dashed border-foreground/15"
          style={{
            transform: `translate(${frame.x}px, ${frame.y}px)`,
            width: frame.width,
            height: frame.height,
          }}
        >
          <span className="absolute top-1.5 left-3 flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            <StatusDot tone={dotTones[phaseTones[frame.phase]]} />
            {phaseLabels[frame.phase]}
          </span>
        </div>
      ))}
      {turn && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute flex flex-col items-center"
          style={{
            transform: `translate(${turn.x}px, ${turn.top}px)`,
            height: turn.height,
          }}
        >
          <span className="h-full w-px border-l border-dashed border-border" />
          <Badge
            appearance="outline"
            className="absolute top-1/2 -translate-y-1/2 border-border bg-background"
          >
            Author turn
          </Badge>
        </div>
      )}
    </ViewportPortal>
  );
}
