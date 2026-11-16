import {
  CircleX,
  Eye,
  Redo2,
  Save,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  Workflow,
  X,
} from 'lucide-react';
import type { StartWorkflowTaskInput } from '@nesvo/contracts';
import { cn } from 'cn';
import type { Provider, ProviderStates } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { PanelAction } from '@/shared/ui/panel';
import { RunPopover } from './run-popover';
import type { EditorState } from './use-editor-state';

type Props = {
  state: EditorState;
  directory: string;
  statuses: ProviderStates;
  issuesOpen: boolean;
  onToggleIssues: () => void;
  overlay: { available: boolean; on: boolean; onToggle: () => void };
  onRefreshProvider: (provider: Provider) => void;
  onRun: ((input: StartWorkflowTaskInput) => Promise<void>) | null;
  onClose: () => void;
};

const scopeLabels = { global: 'Global', project: 'Project' } as const;

export function Toolbar({
  state,
  directory,
  statuses,
  issuesOpen,
  onToggleIssues,
  overlay,
  onRefreshProvider,
  onRun,
  onClose,
}: Props) {
  const errors = state.issues.filter(i => i.severity === 'error').length;
  const warnings = state.issues.length - errors;
  const settingsOpen = state.selection.kind === 'workflow';
  const saveState = state.saving
    ? 'Saving…'
    : state.dirty
      ? 'Unsaved changes'
      : state.document.hash
        ? 'Saved'
        : 'Not saved yet';
  const runBlocked = state.dirty
    ? 'Save the workflow before running it.'
    : !state.document.hash
      ? 'Save the workflow before running it.'
      : state.validation.hasErrors
        ? 'Fix the errors before running.'
        : null;
  return (
    <div
      role="toolbar"
      aria-label="Graph editor"
      className="flex h-11 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3"
    >
      <Workflow
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        aria-label="Workflow name"
        data-editor-name
        value={state.document.name}
        placeholder="Untitled workflow"
        spellCheck={false}
        onChange={event =>
          state.setWorkflowFields({ name: event.target.value })
        }
        className="h-7 w-56 min-w-0 rounded-md bg-transparent px-1.5 text-[13px] font-semibold text-foreground transition-colors duration-100 outline-none placeholder:font-normal placeholder:text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
      />
      <span className="shrink-0 rounded-full border px-1.5 text-2xs leading-4 text-muted-foreground">
        {scopeLabels[state.document.scope]}
      </span>
      <span
        role="status"
        data-editor-save-state={
          state.saving ? 'saving' : state.dirty ? 'unsaved' : 'saved'
        }
        className="flex shrink-0 items-center gap-1.5 pl-1 text-2xs text-muted-foreground"
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            state.dirty ? 'bg-warning-foreground' : 'bg-success-foreground',
            !state.dirty && !state.document.hash && 'bg-muted-foreground',
          )}
        />
        {saveState}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <PanelAction
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!state.canUndo}
          onClick={state.undo}
        >
          <Undo2 />
        </PanelAction>
        <PanelAction
          aria-label="Redo"
          title="Redo (Ctrl+Y)"
          disabled={!state.canRedo}
          onClick={state.redo}
        >
          <Redo2 />
        </PanelAction>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
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
            Last run
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={settingsOpen}
          className="h-7 text-muted-foreground aria-pressed:bg-highlight aria-pressed:text-foreground"
          onClick={() =>
            state.select(settingsOpen ? { kind: 'none' } : { kind: 'workflow' })
          }
        >
          <Settings2 />
          Settings
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={issuesOpen}
          className="h-7 text-muted-foreground aria-pressed:bg-highlight aria-pressed:text-foreground"
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
        {onRun && (
          <RunPopover
            workflowName={state.document.name}
            directory={directory}
            specs={state.catalog.specs}
            statuses={statuses}
            blockedReason={runBlocked}
            onRefreshProvider={onRefreshProvider}
            onRun={onRun}
          />
        )}
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
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <PanelAction aria-label="Close graph editor" onClick={onClose}>
          <X />
        </PanelAction>
      </div>
    </div>
  );
}
