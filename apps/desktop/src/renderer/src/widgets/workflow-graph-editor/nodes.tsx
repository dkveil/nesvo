import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Handle,
  NodeToolbar,
  Position,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Copy, Plus, Trash2, Zap } from 'lucide-react';
import type { StepType } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import {
  phaseLabels,
  stepStateLabels,
  stepStateTones,
  type StepDisplayState,
} from '@/entities/workflow';
import { StepStateIcon } from '@/entities/workflow/step-state-icon';
import {
  isDraftStep,
  NODE_HEIGHT_PX,
  NODE_WIDTH_PX,
  phaseTones,
  START_NODE_WIDTH_PX,
  stepTypeLabels,
  type EdgeCondition,
  type EditorNode,
  type NodeIssue,
} from '@/entities/workflow-graph';
import { StatusIcon } from '@/entities/status';
import { AddTile } from '@/shared/ui/add-tile';
import { Badge } from '@/shared/ui/badge';
import { IconButton } from '@/shared/ui/icon-button';
import { StatusDot } from '@/shared/ui/status-dot';
import { AddedByAssistantBadge } from '@/widgets/workflow-assistant/added-by-assistant-badge';
import { HOVER_LINGER_MS } from './canvas-types';
import { StepGlyph } from './step-glyph';
import { dotTones } from './tone-dot';

export type RunBadge = { state: StepDisplayState; attempts: number };

export type StepNodeData = {
  editor: EditorNode;
  issues: NodeIssue[];
  run: RunBadge | null;
  addedByAssistant: boolean;
  freeSuccess: boolean;
  freeFailure: boolean;
  onAdd: (when: EdgeCondition, event: ReactMouseEvent) => void;
  onDelete: () => void;
  onDuplicate: () => void;
};
export type StepNode = Node<StepNodeData, 'step'>;

export type StartNodeData = {
  workflowName: string;
  automations: number;
  onAdd: (event: ReactMouseEvent) => void;
};
export type StartNode = Node<StartNodeData, 'start'>;

export type PlaceholderNodeData = { onAdd: (event: ReactMouseEvent) => void };
export type PlaceholderNode = Node<PlaceholderNodeData, 'placeholder'>;

export type EditorCanvasNode = StepNode | StartNode | PlaceholderNode;

const handleClass =
  '!size-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground transition-colors duration-fast ease-out';

const card =
  'group/node relative flex items-center gap-2.5 rounded-overlay border bg-card pr-3 pl-2 text-left shadow-xs transition-[border-color,box-shadow] duration-fast ease-out';

const stepNodeSize = { width: NODE_WIDTH_PX, height: NODE_HEIGHT_PX };

const startNodeSize = { width: START_NODE_WIDTH_PX, height: NODE_HEIGHT_PX };

const tile =
  'flex size-10 shrink-0 items-center justify-center rounded-surface bg-accent text-muted-foreground';

const stepDetail = (step: EditorNode['step']) => {
  if (step.type === 'human') return 'Waits for your decision';
  if (step.type === 'agent')
    return step.skill ? `Skill ${step.skill}` : 'Agent review';
  if (step.type !== 'command' && step.type !== 'action')
    return stepTypeLabels[step.type];
  const line = step.body
    .split('\n')
    .map(item => item.trim())
    .find(item => item && !item.startsWith('#'));
  if (line) return line;
  return step.type === 'action' ? 'Action' : 'Command';
};

const useLinger = () => {
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = () => {
    if (timer.current) clearTimeout(timer.current);
    setHovered(true);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(false), HOVER_LINGER_MS);
  };
  return { hovered, enter, leave };
};

function AddButton({
  id,
  when,
  className,
  onClick,
}: {
  id: string;
  when: EdgeCondition;
  className?: string;
  onClick: (event: ReactMouseEvent) => void;
}) {
  return (
    <IconButton
      size={20}
      shape="round"
      tone={when === 'failure' ? 'danger' : 'default'}
      data-node-add={id}
      data-node-add-when={when}
      label={
        when === 'failure'
          ? `Add a step after ${id} fails`
          : `Add a step after ${id}`
      }
      className={cn(
        'nodrag nopan absolute border bg-card shadow-xs transition-[color,background-color,opacity,scale]',
        className,
      )}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        onClick(event);
      }}
    >
      <Plus aria-hidden="true" />
    </IconButton>
  );
}

const typeTileTone: Record<StepType, string> = {
  command: 'text-foreground',
  agent: 'text-info-foreground',
  human: 'text-warning-foreground',
  action: 'text-error-foreground',
  'wait-ci': 'text-info-foreground',
  until: 'text-info-foreground',
  probe: 'text-info-foreground',
};

export function StepNodeView({ data, selected }: NodeProps<StepNode>) {
  const { editor, issues, run, freeSuccess, freeFailure, addedByAssistant } =
    data;
  const step = editor.step;
  const { hovered, enter, leave } = useLinger();
  const errors = issues.filter(issue => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  const tone = run ? stepStateTones[run.state] : phaseTones[step.phase];
  const routesFailure = step.type !== 'human';
  const subtitle = `${phaseLabels[step.phase]} · ${stepDetail(step)}`;
  return (
    <>
      <NodeToolbar
        isVisible={hovered || selected}
        position={Position.Top}
        offset={6}
        align="end"
        className="nodrag nopan"
      >
        <div
          role="toolbar"
          aria-label={`Actions for ${step.name}`}
          onMouseEnter={enter}
          onMouseLeave={leave}
          className="flex items-center gap-0.5 rounded-surface border bg-card p-0.5 shadow-(--popover-shadow)"
        >
          <IconButton
            size={24}
            data-node-duplicate={editor.id}
            label={`Duplicate ${step.name}`}
            shortcut="Ctrl D"
            onClick={event => {
              event.stopPropagation();
              data.onDuplicate();
            }}
          >
            <Copy aria-hidden="true" />
          </IconButton>
          <IconButton
            size={24}
            tone="danger"
            data-node-delete={editor.id}
            label={`Remove ${step.name} from the workflow`}
            shortcut="Delete"
            onClick={event => {
              event.stopPropagation();
              data.onDelete();
            }}
          >
            <Trash2 aria-hidden="true" />
          </IconButton>
        </div>
      </NodeToolbar>
      <div
        data-editor-node={editor.id}
        data-run-state={run?.state ?? undefined}
        onMouseEnter={enter}
        onMouseLeave={leave}
        title={
          run
            ? `${step.name} · ${stepStateLabels[run.state]}`
            : issues.map(issue => issue.message).join('\n') || undefined
        }
        style={stepNodeSize}
        className={cn(
          card,
          selected && 'border-ring shadow-[0_0_0_1px_var(--ring)]',
          !selected && hovered && 'border-foreground/25',
          !selected && errors > 0 && 'border-error-foreground/60',
        )}
      >
        <span className={cn(tile, typeTileTone[step.type])}>
          <StepGlyph type={step.type} className="size-4.5 text-current" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-ui font-medium">
              {step.name}
            </span>
            {isDraftStep(step) && (
              <Badge appearance="outline" size="xs">
                New
              </Badge>
            )}
            {addedByAssistant && !isDraftStep(step) && (
              <AddedByAssistantBadge />
            )}
          </div>
          <div className="truncate text-2xs leading-4 text-muted-foreground">
            {subtitle}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 self-start pt-2.5">
          {run ? (
            <span
              className="flex items-center gap-1 text-2xs tabular-nums"
              aria-label={`${stepStateLabels[run.state]}${run.attempts > 1 ? `, attempt ${run.attempts}` : ''}`}
            >
              {run.attempts > 1 && (
                <span className="text-muted-foreground">×{run.attempts}</span>
              )}
              <StepStateIcon state={run.state} className="size-4" />
            </span>
          ) : errors > 0 || warnings > 0 ? (
            <span className="flex items-center gap-1.5 text-2xs tabular-nums">
              {errors > 0 && (
                <span
                  role="img"
                  aria-label={`${errors} ${errors === 1 ? 'error' : 'errors'}`}
                  className="inline-flex items-center gap-0.5 text-error-foreground"
                >
                  <StatusIcon status="error" />
                  {errors}
                </span>
              )}
              {warnings > 0 && (
                <span
                  role="img"
                  aria-label={`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`}
                  className="inline-flex items-center gap-0.5 text-warning-foreground"
                >
                  <StatusIcon status="warning" />
                  {warnings}
                </span>
              )}
            </span>
          ) : (
            <StatusDot size="md" tone={dotTones[tone]} />
          )}
        </div>
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          aria-label={`Connect into ${step.name}`}
          className={handleClass}
        />
        <Handle
          id="success"
          type="source"
          position={Position.Right}
          aria-label={`Connect from ${step.name}`}
          className={handleClass}
          style={routesFailure ? { top: '40%' } : undefined}
        />
        {routesFailure && (
          <Handle
            id="failure"
            type="source"
            position={Position.Right}
            aria-label={`Connect from ${step.name} on failure`}
            title="On failure"
            className={cn(handleClass, '!bg-error-foreground')}
            style={{ top: '76%' }}
          />
        )}
        {routesFailure && (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute left-[calc(100%+9px)] top-[76%] -translate-y-1/2 text-micro leading-none text-error-foreground transition-opacity duration-fast ease-out',
              hovered || selected || !freeFailure ? 'opacity-100' : 'opacity-0',
            )}
            style={{
              marginLeft: freeFailure && (hovered || selected) ? 28 : 0,
            }}
          >
            fail
          </span>
        )}
        {freeSuccess && (
          <AddButton
            id={editor.id}
            when="success"
            className={cn(
              'left-[calc(100%+12px)] -translate-y-1/2',
              routesFailure ? 'top-[40%]' : 'top-1/2',
              hovered || selected ? 'opacity-100' : 'opacity-70',
            )}
            onClick={event => data.onAdd('success', event)}
          />
        )}
        {routesFailure && freeFailure && (
          <AddButton
            id={editor.id}
            when="failure"
            className={cn(
              'top-[76%] left-[calc(100%+12px)] -translate-y-1/2 enabled:hover:border-error-foreground',
              hovered || selected
                ? 'opacity-100'
                : 'pointer-events-none opacity-0',
            )}
            onClick={event => data.onAdd('failure', event)}
          />
        )}
      </div>
    </>
  );
}

export function StartNodeView({ data, selected }: NodeProps<StartNode>) {
  const { hovered, enter, leave } = useLinger();
  const triggers =
    data.automations === 0
      ? 'Manual run from a new thread'
      : `Manual run · ${data.automations} ${data.automations === 1 ? 'automation' : 'automations'}`;
  return (
    <div
      data-editor-start
      onMouseEnter={enter}
      onMouseLeave={leave}
      style={startNodeSize}
      className={cn(
        'group/node relative flex items-center gap-2.5 rounded-l-composer rounded-r-overlay border bg-card pr-3 pl-2 shadow-xs transition-[border-color,box-shadow] duration-fast ease-out',
        selected && 'border-ring shadow-[0_0_0_1px_var(--ring)]',
        !selected && hovered && 'border-foreground/25',
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
        <Zap aria-hidden="true" className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-ui font-medium">Start</div>
        <div className="truncate text-2xs leading-4 text-muted-foreground">
          {triggers}
        </div>
      </div>
      <Handle
        id="success"
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label="Workflow start"
        className={cn(handleClass, '!bg-primary')}
      />
      <AddButton
        id="__start"
        when="success"
        className="top-1/2 left-[calc(100%+12px)] -translate-y-1/2 opacity-80"
        onClick={data.onAdd}
      />
    </div>
  );
}

export function PlaceholderNodeView({ data }: NodeProps<PlaceholderNode>) {
  return (
    <AddTile
      data-add-first
      onClick={data.onAdd}
      style={stepNodeSize}
      title="Add first step"
      description="A check, an agent, an approval or an action"
      className="nodrag nopan"
    />
  );
}
