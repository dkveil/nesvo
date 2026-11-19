import { useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Workflow } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import type { DefinitionCatalog, Session } from '@nesvo/contracts';
import { errorDetail, type Provider } from '@/entities/session';
import { ComposerChip } from '@/features/new-thread/composer-chip';
import { workflowIssues } from '@/features/new-thread/workflow-choice';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { Listbox, type ListboxOption } from '@/shared/ui/listbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import {
  assignedWorkflowListed,
  rootLabels,
  sameWorkflow,
  workflowRoots,
  workflowsInRoot,
  type AssignedWorkflow,
  type WorkflowRoot,
} from './workflow-options';

type Props = {
  hostId: string;
  directory: string;
  provider: Provider;
  assigned: Session['workflow'];
  disabled: boolean;
  unsupported?: boolean;
  onAssign: (workflow: AssignedWorkflow | null) => void;
  onOpenEditor: (name: string, root: WorkflowRoot) => void;
};

type CatalogState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; catalog: DefinitionCatalog };

const NO_WORKFLOW = '';

const optionValue = (workflow: AssignedWorkflow | null) =>
  workflow ? `${workflow.root}:${workflow.name}` : NO_WORKFLOW;

const workflowOptions = (catalog: DefinitionCatalog) =>
  workflowRoots.flatMap(root =>
    workflowsInRoot(catalog, root).map(workflow => {
      const issues = workflowIssues(catalog, workflow.name, '');
      return {
        workflow: { name: workflow.name, root },
        option: {
          value: optionValue({ name: workflow.name, root }),
          label: workflow.name,
          group: rootLabels[root],
          description: issues.length ? (
            <span className="text-warning-foreground">
              {issues.map(issue => issue.message).join(' · ')}
            </span>
          ) : undefined,
        } satisfies ListboxOption<string>,
      };
    }),
  );

export function SessionWorkflowChip({
  hostId,
  directory,
  assigned,
  disabled,
  unsupported = false,
  onAssign,
  onOpenEditor,
}: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CatalogState>({ status: 'idle' });
  const request = useRef(0);
  const load = () => {
    const current = ++request.current;
    setState({ status: 'loading' });
    window.nesvo.workflows.listDefinitions(hostId, { directory }).then(
      catalog => {
        if (current === request.current)
          setState({ status: 'loaded', catalog });
      },
      failure => {
        if (current === request.current)
          setState({
            status: 'error',
            message: `Could not read workflows. ${errorDetail(failure)}`,
          });
      },
    );
  };
  const catalog = state.status === 'loaded' ? state.catalog : null;
  const entries = catalog ? workflowOptions(catalog) : [];
  const missing =
    !!assigned && !!catalog && !assignedWorkflowListed(catalog, assigned);
  const choose = (value: string) => {
    const workflow =
      entries.find(entry => entry.option.value === value)?.workflow ?? null;
    setOpen(false);
    if (!sameWorkflow(workflow, assigned)) onAssign(workflow);
  };
  const label = assigned ? `Workflow: ${assigned.name}` : 'No workflow';
  return (
    <Popover
      open={open && !disabled && !unsupported}
      onOpenChange={next => {
        setOpen(next);
        if (next) load();
      }}
    >
      <Hint
        label={unsupported ? 'Update the host to assign a workflow' : label}
      >
        <PopoverTrigger asChild>
          <ComposerChip
            disabled={disabled || unsupported}
            aria-label={label}
            data-session-workflow={assigned?.name ?? ''}
            icon={<Workflow aria-hidden="true" />}
            size="sm"
            className="relative w-6 justify-center px-0"
          >
            {assigned && (
              <StatusDot tone="info" className="absolute top-0.5 right-0.5" />
            )}
          </ComposerChip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        surface="solid"
        side="top"
        align="start"
        collisionPadding={12}
        aria-label="Session workflow"
        size="md"
        padding="none"
        scroll
        className="flex flex-col gap-2 p-2.5"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs font-medium text-muted-foreground">
            Workflow for the next run
          </p>
          <IconButton
            label="Refresh"
            size={24}
            disabled={state.status === 'loading'}
            onClick={load}
          >
            <RefreshCw
              className={cn(
                state.status === 'loading' &&
                  'animate-spin motion-reduce:animate-none',
              )}
            />
          </IconButton>
        </div>
        {state.status === 'error' && (
          <StatusMessage tone="error" className="px-1">
            {state.message}
          </StatusMessage>
        )}
        {state.status === 'loading' && !catalog && (
          <StatusMessage tone="loading" className="px-1">
            Reading workflows…
          </StatusMessage>
        )}
        {missing && assigned && (
          <StatusMessage tone="warning" className="px-1">
            {`${assigned.name} is no longer available in the ${rootLabels[assigned.root].toLowerCase()} workflows. Pick another workflow or None; the next run will not start with it.`}
          </StatusMessage>
        )}
        {catalog && (
          <Listbox
            label="Workflows"
            options={[
              { value: NO_WORKFLOW, label: 'None' },
              ...entries.map(entry => entry.option),
            ]}
            value={optionValue(assigned)}
            onSelect={choose}
            className="-mx-1"
          />
        )}
        {catalog && entries.length === 0 && (
          <StatusMessage className="px-1">
            No project or global workflows yet.
          </StatusMessage>
        )}
        {assigned && (
          <div className="border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start"
              disabled={!assigned}
              onClick={() => {
                if (!assigned) return;
                setOpen(false);
                onOpenEditor(assigned.name, assigned.root);
              }}
            >
              <ExternalLink aria-hidden="true" />
              Open in editor
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
