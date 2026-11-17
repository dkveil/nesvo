import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, ExternalLink, RefreshCw, Workflow } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import type { DefinitionCatalog, Session } from '@nesvo/contracts';
import { errorDetail, type Provider } from '@/entities/session';
import { ComposerChip } from '@/features/new-thread/composer-chip';
import { workflowIssues } from '@/features/new-thread/workflow-choice';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
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

const optionRow =
  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-100 enabled:hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset aria-selected:bg-highlight';

const moveOption = (event: KeyboardEvent<HTMLDivElement>) => {
  const forward = event.key === 'ArrowDown';
  if (!forward && event.key !== 'ArrowUp') return;
  const options = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    ),
  ];
  const index = options.findIndex(option => option === document.activeElement);
  const next =
    options[(index + (forward ? 1 : -1) + options.length) % options.length];
  if (!next) return;
  event.preventDefault();
  next.focus();
};

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
  const missing =
    !!assigned && !!catalog && !assignedWorkflowListed(catalog, assigned);
  const choose = (workflow: AssignedWorkflow | null) => {
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
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled || unsupported}
          aria-label={label}
          data-session-workflow={assigned?.name ?? ''}
          title={
            unsupported
              ? 'Update the host to assign a workflow'
              : 'Applies to the next run'
          }
          className={cn(assigned && 'text-foreground')}
        >
          <Workflow aria-hidden="true" />
          <span className="truncate">{label}</span>
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Session workflow"
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 overflow-y-auto p-2.5"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs font-medium text-muted-foreground">
            Applies to the next run
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground"
            aria-label="Refresh"
            title="Refresh"
            disabled={state.status === 'loading'}
            onClick={load}
          >
            <RefreshCw
              className={cn(
                'size-3.5',
                state.status === 'loading' &&
                  'animate-spin motion-reduce:animate-none',
              )}
            />
          </Button>
        </div>
        {state.status === 'error' && (
          <p
            role="alert"
            className="px-1 text-xs text-destructive [overflow-wrap:anywhere]"
          >
            {state.message}
          </p>
        )}
        {state.status === 'loading' && !catalog && (
          <p role="status" className="px-1 text-xs text-muted-foreground">
            Reading workflows…
          </p>
        )}
        {missing && assigned && (
          <p
            role="alert"
            className="px-1 text-xs text-warning-foreground [overflow-wrap:anywhere]"
          >
            {`${assigned.name} is no longer available in the ${rootLabels[assigned.root].toLowerCase()} workflows. Pick another workflow or None; the next run will not start with it.`}
          </p>
        )}
        {catalog && (
          <div
            role="listbox"
            aria-label="Workflows"
            className="space-y-1"
            onKeyDown={moveOption}
          >
            <button
              type="button"
              role="option"
              aria-selected={!assigned}
              className={optionRow}
              onClick={() => choose(null)}
            >
              <Check
                className={cn(
                  'mt-0.5 size-3.5 shrink-0',
                  assigned && 'invisible',
                )}
                aria-hidden="true"
              />
              <span className="flex-1 text-[13px]">None</span>
            </button>
            {workflowRoots.map(root => {
              const entries = workflowsInRoot(catalog, root);
              return (
                <div
                  key={root}
                  role="group"
                  aria-label={rootLabels[root]}
                  className="space-y-0.5"
                >
                  <p className="px-2 pt-1.5 text-2xs font-medium text-muted-foreground">
                    {rootLabels[root]}
                  </p>
                  {entries.length === 0 && (
                    <p className="px-2 py-1 text-2xs text-muted-foreground">
                      No workflows
                    </p>
                  )}
                  {entries.map(workflow => {
                    const entry = { name: workflow.name, root };
                    const selected = sameWorkflow(entry, assigned);
                    const issues = workflowIssues(catalog, workflow.name, '');
                    return (
                      <button
                        key={`${root}:${workflow.name}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-workflow-option={workflow.name}
                        data-workflow-root={root}
                        className={optionRow}
                        onClick={() => choose(entry)}
                      >
                        <Check
                          className={cn(
                            'mt-0.5 size-3.5 shrink-0',
                            !selected && 'invisible',
                          )}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium">
                              {workflow.name}
                            </span>
                            <span className="shrink-0 text-2xs text-muted-foreground">
                              {rootLabels[root]}
                            </span>
                          </span>
                          {issues.map((issue, index) => (
                            <span
                              key={index}
                              className="mt-0.5 block text-2xs leading-4 text-warning-foreground [overflow-wrap:anywhere]"
                            >
                              {issue.message}
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        <div className="border-t pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start gap-2 px-2 text-xs"
            disabled={!assigned}
            onClick={() => {
              if (!assigned) return;
              setOpen(false);
              onOpenEditor(assigned.name, assigned.root);
            }}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Open in editor
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
