import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CircleX, Play, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import {
  stepStateLabels,
  stepStateTones,
  type StepDisplayState,
} from '@/entities/pipeline';
import { StepStateIcon } from '@/entities/pipeline/step-state-icon';
import {
  isDraftStep,
  phaseTones,
  stepTypeLabels,
  toneColor,
  type EditorNode,
  type NodeIssue,
} from '@/entities/pipeline-graph';
import { StepGlyph } from './step-glyph';

export type StepNodeData = {
  editor: EditorNode;
  issues: NodeIssue[];
  runState: StepDisplayState | null;
};
export type StepNode = Node<StepNodeData, 'step'>;
export type StartNodeData = { pipelineName: string; automations: number };
export type StartNode = Node<StartNodeData, 'start'>;
export type EditorCanvasNode = StepNode | StartNode;

const handleStyle = { width: 9, height: 9 };

const nodeShell =
  'relative flex h-14 items-center gap-2.5 rounded-lg border bg-card px-3 text-left shadow-xs transition-[border-color,box-shadow] duration-100';

export function StepNodeView({ data, selected }: NodeProps<StepNode>) {
  const { editor, issues, runState } = data;
  const step = editor.step;
  const errors = issues.filter(issue => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  const tone = runState ? stepStateTones[runState] : phaseTones[step.phase];
  const meta = [
    stepTypeLabels[step.type],
    step.skill ? `Skill ${step.skill}` : step.timeout,
    isDraftStep(step) ? 'New' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      data-editor-node={editor.id}
      data-run-state={runState ?? undefined}
      title={
        runState
          ? `${step.name} · ${stepStateLabels[runState]}`
          : issues.map(issue => issue.message).join('\n') || undefined
      }
      className={cn(
        nodeShell,
        'w-56',
        selected && 'border-ring ring-1 ring-ring',
        !selected && errors > 0 && 'border-error-foreground/60',
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-2.5 left-0 w-0.5 rounded-full"
        style={{ background: toneColor[tone] }}
      />
      <StepGlyph type={step.type} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] leading-4 font-medium">
          {step.name}
        </div>
        <div className="truncate text-2xs leading-4 text-muted-foreground">
          {meta}
        </div>
      </div>
      {runState ? (
        <StepStateIcon state={runState} className="size-4 shrink-0" />
      ) : (
        (errors > 0 || warnings > 0) && (
          <span className="flex shrink-0 items-center gap-1.5 text-2xs tabular-nums">
            {errors > 0 && (
              <span
                role="img"
                aria-label={`${errors} ${errors === 1 ? 'error' : 'errors'}`}
                className="inline-flex items-center gap-0.5 text-error-foreground"
              >
                <CircleX className="size-3" />
                {errors}
              </span>
            )}
            {warnings > 0 && (
              <span
                role="img"
                aria-label={`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`}
                className="inline-flex items-center gap-0.5 text-warning-foreground"
              >
                <TriangleAlert className="size-3" />
                {warnings}
              </span>
            )}
          </span>
        )
      )}
      <Handle
        type="target"
        position={Position.Left}
        aria-label={`Connect into ${step.name}`}
        style={handleStyle}
      />
      <Handle
        type="source"
        position={Position.Right}
        aria-label={`Connect from ${step.name}`}
        style={handleStyle}
      />
    </div>
  );
}

export function StartNodeView({ data, selected }: NodeProps<StartNode>) {
  const triggers =
    data.automations === 0
      ? 'New thread'
      : `New thread · ${data.automations} ${data.automations === 1 ? 'automation' : 'automations'}`;
  return (
    <div
      data-editor-start
      className={cn(
        nodeShell,
        'w-48 border-dashed',
        selected && 'border-ring ring-1 ring-ring',
      )}
    >
      <Play
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] leading-4 font-medium">Start</div>
        <div className="truncate text-2xs leading-4 text-muted-foreground">
          {triggers}
        </div>
      </div>
    </div>
  );
}
