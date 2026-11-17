import {
  Eye,
  Redo2,
  Save,
  Settings2,
  ShieldCheck,
  Undo2,
  Workflow,
  X,
} from 'lucide-react';
import type { StartWorkflowTaskInput } from '@nesvo/contracts';
import type { Provider, ProviderStates } from '@/entities/session';
import { StatusIcon } from '@/entities/status';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { Input } from '@/shared/ui/input';
import {
  Toolbar as ToolbarRow,
  ToolbarSeparator,
  ToolbarSpacer,
} from '@/shared/ui/panel';
import { StatusDot } from '@/shared/ui/status-dot';
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
    <ToolbarRow label="Graph editor" className="h-10 gap-1.5 pr-1.5 pl-3">
      <Workflow
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        variant="ghost"
        aria-label="Workflow name"
        data-editor-name
        value={state.document.name}
        placeholder="Untitled workflow"
        spellCheck={false}
        onChange={event =>
          state.setWorkflowFields({ name: event.target.value })
        }
        className="focus-ring w-56 rounded-control px-1.5 font-semibold placeholder:font-normal hover:bg-accent focus-visible:bg-accent"
      />
      <Badge appearance="outline" size="xs">
        {scopeLabels[state.document.scope]}
      </Badge>
      <span
        role="status"
        data-editor-save-state={
          state.saving ? 'saving' : state.dirty ? 'unsaved' : 'saved'
        }
        className="flex shrink-0 items-center gap-1.5 pl-1 text-2xs text-muted-foreground"
      >
        <StatusDot
          tone={
            state.dirty
              ? 'warning'
              : state.document.hash
                ? 'success'
                : 'neutral'
          }
        />
        {saveState}
      </span>
      <ToolbarSpacer />
      <div className="flex items-center gap-0.5">
        <IconButton
          label="Undo"
          shortcut="Ctrl Z"
          disabled={!state.canUndo}
          onClick={state.undo}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label="Redo"
          shortcut="Ctrl Y"
          disabled={!state.canRedo}
          onClick={state.redo}
        >
          <Redo2 />
        </IconButton>
        <ToolbarSeparator />
        {overlay.available && (
          <Button
            type="button"
            variant="ghost"
            aria-pressed={overlay.on}
            selected={overlay.on}
            className="text-muted-foreground"
            onClick={overlay.onToggle}
          >
            <Eye />
            Last run
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          aria-pressed={settingsOpen}
          selected={settingsOpen}
          className="text-muted-foreground"
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
          aria-pressed={issuesOpen}
          selected={issuesOpen}
          className="text-muted-foreground"
          onClick={onToggleIssues}
        >
          <ShieldCheck />
          Validate
          {errors > 0 && (
            <span className="inline-flex items-center gap-0.5 text-error-foreground tabular-nums">
              <StatusIcon status="error" />
              {errors}
            </span>
          )}
          {warnings > 0 && (
            <span className="inline-flex items-center gap-0.5 text-warning-foreground tabular-nums">
              <StatusIcon status="warning" />
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
          title="Save (Ctrl+S)"
          disabled={!state.dirty || state.saving || state.validation.hasErrors}
          onClick={() => void state.save()}
        >
          <Save />
          {state.saving ? 'Saving…' : 'Save'}
        </Button>
        <ToolbarSeparator />
        <IconButton label="Close graph editor" onClick={onClose}>
          <X />
        </IconButton>
      </div>
    </ToolbarRow>
  );
}
