import { useRef, useState } from 'react';
import { RefreshCw, Workflow } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import type { DefinitionCatalog, WorkflowsApi } from '@nesvo/contracts';
import {
  errorDetail,
  modelLabel,
  ProviderGlyph,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { Disclosure } from '@/shared/ui/disclosure';
import { IconButton } from '@/shared/ui/icon-button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Listbox } from '@/shared/ui/listbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { Hint } from '@/shared/ui/tooltip';
import { ComposerChip } from './composer-chip';
import {
  gateModels,
  workflowIssues,
  resolveGate,
  type WorkflowChoice,
} from './workflow-choice';

type Props = {
  hostId: string;
  directory: string;
  connected: boolean;
  authorProvider: Provider;
  statuses: ProviderStates;
  api: Pick<WorkflowsApi, 'listDefinitions'>;
  value: WorkflowChoice | null;
  disabled?: boolean;
  onChange: (value: WorkflowChoice | null) => void;
};

type CatalogState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; catalog: DefinitionCatalog };

const NO_WORKFLOW = '';

const specName = (path: string) =>
  path.split(/[\\/]/).at(-1)?.replace(/\.md$/i, '') ?? path;

const issueCount = (count: number) =>
  `${count} ${count === 1 ? 'issue' : 'issues'}`;

export function WorkflowPicker({
  hostId,
  directory,
  connected,
  authorProvider,
  statuses,
  api,
  value,
  disabled = false,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CatalogState>({ status: 'idle' });
  const request = useRef(0);
  const trimmed = directory.trim();
  const load = () => {
    if (!connected) return;
    const current = ++request.current;
    setState({ status: 'loading' });
    api.listDefinitions(hostId, { directory: trimmed }).then(
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
  const gate = resolveGate(value, authorProvider, statuses);
  const choose = (changes: Partial<WorkflowChoice>) => {
    const base: WorkflowChoice = value ?? {
      workflowName: '',
      specPath: '',
      specTitle: null,
      isolation: !!trimmed,
      gateProvider: gate.provider,
      gateModel: gate.model,
      gateEdited: false,
    };
    onChange({ ...base, ...changes });
  };
  const chooseWorkflow = (name: string) => {
    if (!catalog || name === NO_WORKFLOW) {
      onChange(null);
      return;
    }
    const spec = catalog.specs.find(
      item => item.source.path === value?.specPath,
    );
    const firstSpec = catalog.specs.find(item => item.workflow === name);
    const keep = !!value?.specPath && (!spec || spec.workflow === name);
    choose({
      workflowName: name,
      specPath: keep ? value.specPath : (firstSpec?.source.path ?? ''),
      specTitle: keep ? value.specTitle : (firstSpec?.title ?? null),
    });
  };
  const chooseSpec = (path: string) => {
    const spec = catalog?.specs.find(item => item.source.path === path);
    if (spec)
      choose({
        specPath: spec.source.path,
        specTitle: spec.title,
        workflowName: spec.workflow,
      });
  };
  const selectedWorkflow = catalog?.workflows.find(
    workflow => workflow.name === value?.workflowName,
  );
  const isolationReason = !trimmed
    ? 'Choose a project folder to isolate the task.'
    : '';
  const gateProvider = gate.provider;
  const models = gate.models;
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) load();
      }}
    >
      <Hint
        label={
          value?.workflowName
            ? `Workflow: ${value.workflowName}${value.specPath ? ` · ${specName(value.specPath)}` : ''}`
            : 'Run this task through a workflow'
        }
      >
        <PopoverTrigger asChild>
          <ComposerChip
            disabled={disabled}
            aria-label={
              value?.workflowName
                ? `Workflow: ${value.workflowName}`
                : 'Workflow'
            }
            data-workflow={value?.workflowName || undefined}
            icon={<Workflow aria-hidden="true" />}
            className={cn(value?.workflowName && 'text-foreground')}
          >
            <span>{value?.workflowName || 'Workflow'}</span>
          </ComposerChip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        aria-label="Workflow"
        size="lg"
        padding="none"
        scroll
        className="flex flex-col gap-3 p-2.5"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs font-medium text-muted-foreground">Workflow</p>
          <IconButton
            label="Refresh workflows"
            size={24}
            disabled={!connected || state.status === 'loading'}
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
        {!connected && (
          <StatusMessage className="px-1">
            Connect this computer to list its workflows.
          </StatusMessage>
        )}
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
        {catalog && (
          <div className="space-y-1">
            <Listbox
              label="Workflows"
              options={[
                { value: NO_WORKFLOW, label: 'No workflow' },
                ...catalog.workflows.map(workflow => {
                  const issues = workflowIssues(catalog, workflow.name, '');
                  return {
                    value: workflow.name,
                    label: workflow.name,
                    description: workflow.description || undefined,
                    trailing: (
                      <>
                        {workflow.steps.length} steps
                        {issues.length > 0 && (
                          <span className="text-warning-foreground">
                            {' · '}
                            {issueCount(issues.length)}
                          </span>
                        )}
                      </>
                    ),
                  };
                }),
              ]}
              value={value?.workflowName || NO_WORKFLOW}
              onSelect={chooseWorkflow}
              className="-mx-1"
            />
            {catalog.workflows.length === 0 && (
              <StatusMessage className="px-1">
                No workflows in .agents/workflows for this folder.
              </StatusMessage>
            )}
            {catalog.issues.length > 0 && (
              <Disclosure
                title={
                  <span className="text-warning-foreground">
                    {catalog.issues.length} definition{' '}
                    {catalog.issues.length === 1 ? 'issue' : 'issues'}
                  </span>
                }
              >
                <ul className="space-y-1.5 text-2xs">
                  {catalog.issues.slice(0, 20).map((issue, index) => (
                    <li key={index} className="[overflow-wrap:anywhere]">
                      <span
                        className={
                          issue.severity === 'error'
                            ? 'text-error-foreground'
                            : 'text-warning-foreground'
                        }
                      >
                        {issue.severity === 'error' ? 'Error' : 'Warning'}
                      </span>{' '}
                      {issue.message}
                      <span className="block font-mono">
                        {specName(issue.path)}
                        {issue.line ? `:${issue.line}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </div>
        )}
        {value?.workflowName && (
          <>
            <div className="space-y-1 border-t pt-2.5">
              <p className="px-1 text-xs font-medium text-muted-foreground">
                Task spec
              </p>
              {catalog && catalog.specs.length > 0 && (
                <Listbox
                  label="Task specs"
                  options={catalog.specs.map(spec => ({
                    value: spec.source.path,
                    label: spec.title ?? specName(spec.source.path),
                    description: `${specName(spec.source.path)}.md · ${spec.workflow}`,
                  }))}
                  value={value.specPath}
                  onSelect={chooseSpec}
                  className="-mx-1"
                />
              )}
              <div className="space-y-1 px-1 pt-1">
                <Label htmlFor="workflow-spec-path" className="text-2xs">
                  Spec path
                </Label>
                <Input
                  id="workflow-spec-path"
                  placeholder="Path to a Markdown spec in this project"
                  value={value.specPath}
                  maxLength={4096}
                  onChange={event =>
                    choose({ specPath: event.target.value, specTitle: null })
                  }
                />
              </div>
            </div>
            <div className="space-y-1 border-t px-1 pt-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="workflow-isolation">
                  Isolate in a worktree
                </Label>
                <Switch
                  id="workflow-isolation"
                  checked={value.isolation && !isolationReason}
                  disabled={!!isolationReason}
                  onCheckedChange={checked => choose({ isolation: checked })}
                />
              </div>
              <p className="text-2xs text-muted-foreground">
                {isolationReason ||
                  'A new branch and worktree from the repository top folder. Nothing is pushed or merged.'}
              </p>
            </div>
            <div className="space-y-1.5 border-t px-1 pt-2.5">
              <p className="text-xs font-medium text-muted-foreground">Gates</p>
              <div className="flex items-center gap-2">
                <SegmentedControl
                  label="Gate provider"
                  value={gateProvider}
                  onChange={provider =>
                    choose({
                      gateProvider: provider,
                      gateModel: gateModels(statuses, provider)[0]!.id,
                      gateEdited: true,
                    })
                  }
                  options={providers.map(provider => ({
                    value: provider,
                    label: provider,
                    icon: <ProviderGlyph provider={provider} />,
                  }))}
                />
                <Select
                  value={gate.model}
                  onValueChange={gateModel =>
                    choose({
                      gateProvider,
                      gateModel,
                      gateEdited: true,
                    })
                  }
                >
                  <SelectTrigger
                    aria-label="Gate model"
                    className="min-w-0 flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map(model => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label || modelLabel(model.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-2xs text-muted-foreground">
                Agent gates run read-only in a fresh session
                {gateProvider !== authorProvider
                  ? ', on a different provider than the author.'
                  : '.'}
              </p>
            </div>
            {selectedWorkflow && (
              <p className="border-t px-1 pt-2.5 text-2xs text-muted-foreground">
                {selectedWorkflow.steps.map(step => step.name).join(' → ')}
              </p>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
