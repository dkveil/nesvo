import { useReactFlow, useViewport } from '@xyflow/react';
import {
  CircleX,
  Eye,
  LayoutGrid,
  Maximize,
  Minus,
  Plus,
  Save,
  ShieldCheck,
  TriangleAlert,
  Workflow,
  X,
} from 'lucide-react';
import type { ResolvedStep } from '@nesvo/contracts';
import { cn } from 'cn';
import { Button } from '@/shared/ui/button';
import { PanelAction } from '@/shared/ui/panel';
import { Palette } from './palette';
import type { EditorState } from './use-editor-state';

type Props = {
  state: EditorState;
  catalogSteps: ResolvedStep[];
  issuesOpen: boolean;
  onToggleIssues: () => void;
  overlay: { available: boolean; on: boolean; onToggle: () => void };
  onClose: () => void;
};

const scopeLabels = { global: 'Global', project: 'Project' } as const;

export function Toolbar({
  state,
  catalogSteps,
  issuesOpen,
  onToggleIssues,
  overlay,
  onClose,
}: Props) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const errors = state.issues.filter(i => i.severity === 'error').length;
  const warnings = state.issues.length - errors;
  return (
    <div
      role="toolbar"
      aria-label="Graph editor"
      className="flex h-10 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3"
    >
      <Workflow
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <h2 className="min-w-0 truncate text-[13px] font-semibold">
        {state.document.name || 'New pipeline'}
      </h2>
      <span className="shrink-0 rounded-full border px-1.5 text-2xs leading-4 text-muted-foreground">
        {scopeLabels[state.document.scope]}
      </span>
      {state.dirty && (
        <span
          role="status"
          aria-label="Unsaved changes"
          title="Unsaved changes"
          className="size-1.5 shrink-0 rounded-full bg-warning-foreground"
        />
      )}
      <div className="ml-3 flex items-center gap-1">
        <Palette
          steps={catalogSteps}
          inPipeline={state.document.nodes.map(node => node.id)}
          onAdd={state.addCatalogStep}
          onNew={state.startDraft}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-muted-foreground"
          disabled={state.document.nodes.length === 0}
          onClick={state.autoLayoutAll}
        >
          <LayoutGrid />
          Auto-layout
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={issuesOpen}
          className={cn(
            'h-7 text-muted-foreground aria-pressed:bg-highlight aria-pressed:text-foreground',
          )}
          onClick={onToggleIssues}
        >
          <ShieldCheck />
          Validate
          {errors > 0 && (
            <span className="inline-flex items-center gap-0.5 text-error-foreground tabular-nums">
              <CircleX className="size-3" />
              {errors}
            </span>
          )}
          {warnings > 0 && (
            <span className="inline-flex items-center gap-0.5 text-warning-foreground tabular-nums">
              <TriangleAlert className="size-3" />
              {warnings}
            </span>
          )}
        </Button>
        {overlay.available && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={overlay.on}
            className="h-7 text-muted-foreground aria-pressed:bg-highlight aria-pressed:text-foreground"
            onClick={overlay.onToggle}
          >
            <Eye />
            Show last run
          </Button>
        )}
      </div>
      <div className="ml-auto flex items-center gap-0.5">
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
          onClick={() => void fitView({ padding: 0.25, maxZoom: 1 })}
        >
          <Maximize />
        </PanelAction>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-muted-foreground"
          disabled={!state.dirty || state.saving}
          onClick={state.discard}
        >
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7"
          title="Save (Ctrl+S)"
          disabled={!state.dirty || state.saving || state.validation.hasErrors}
          onClick={() => void state.save()}
        >
          <Save />
          {state.saving ? 'Saving…' : 'Save'}
        </Button>
        <PanelAction aria-label="Close graph editor" onClick={onClose}>
          <X />
        </PanelAction>
      </div>
    </div>
  );
}
