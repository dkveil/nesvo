import { useEffect, useRef, useState } from 'react';
import type { Computer, DefinitionScope, WorkflowsApi } from '@nesvo/contracts';
import {
  ChevronDown,
  Plus,
  RefreshCw,
  SquarePen,
  Workflow,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { StatusIcon } from '@/entities/status';
import {
  phaseLabels,
  phaseOrder,
  type DefinitionCatalog,
  type DefinitionIssue,
  type ResolvedWorkflow,
  type ResolvedStep,
} from '@/entities/workflow';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { EmptyState } from '@/shared/ui/empty-state';
import { Field } from '@/shared/ui/field';
import { IconButton } from '@/shared/ui/icon-button';
import { Input } from '@/shared/ui/input';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { AddedByAssistantBadge } from '@/widgets/workflow-assistant/added-by-assistant-badge';

export type EditorDraft = {
  name: string;
  description: string;
  body: string;
  scope: DefinitionScope;
};

export type EditorTarget = {
  hostId: string;
  directory: string;
  workflowName: string | null;
  catalog: DefinitionCatalog;
  draft?: EditorDraft;
};

type Props = {
  computers: Computer[];
  hostId: string;
  directory: string;
  api: Pick<WorkflowsApi, 'listDefinitions'>;
  onEdit?: (target: EditorTarget) => void;
  onCreate?: (source: { hostId: string; directory: string }) => void;
  refreshToken?: number;
  highlighted?: string[];
  onSourceChange?: (source: { hostId: string; directory: string }) => void;
};

type CatalogState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; catalog: DefinitionCatalog };

const scopeLabels = { global: 'Global', project: 'Project' } as const;

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

const normalized = (path: string) => path.replace(/\\/g, '/').toLowerCase();

const issueScope = (catalog: DefinitionCatalog, issue: DefinitionIssue) => {
  const path = normalized(issue.path);
  if (
    catalog.roots.project &&
    path.startsWith(normalized(catalog.roots.project))
  )
    return 'Project';
  if (catalog.roots.global && path.startsWith(normalized(catalog.roots.global)))
    return 'Global';
  return 'Project';
};

const phaseCounts = (workflow: ResolvedWorkflow) =>
  phaseOrder
    .map(phase => ({
      phase,
      count: workflow.steps.filter(step => step.phase === phase).length,
    }))
    .filter(item => item.count > 0)
    .map(item => `${phaseLabels[item.phase]} ${item.count}`)
    .join(' · ');

const workflowIssueCount = (
  catalog: DefinitionCatalog,
  workflow: ResolvedWorkflow,
) => {
  const paths = new Set(
    [workflow.source.path, ...workflow.steps.map(step => step.source.path)].map(
      normalized,
    ),
  );
  return catalog.issues.filter(issue => paths.has(normalized(issue.path)))
    .length;
};

const stepMeta = (step: ResolvedStep) =>
  [
    step.type[0]!.toUpperCase() + step.type.slice(1),
    step.skill ? `Skill ${step.skill}` : '',
    `Timeout ${step.timeout}`,
    step.retries ? `Retries ${step.retries}` : '',
    step.on_fail === 'fix' ? 'Sends failures back for a fix' : '',
    step.needs.length ? `Needs ${step.needs.join(', ')}` : '',
    scopeLabels[step.source.scope],
  ]
    .filter(Boolean)
    .join(' · ');

function DefinitionStep({
  step,
  index,
}: {
  step: ResolvedStep;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const details = !!step.body.trim() || step.notes.length > 0;
  const meta = stepMeta(step);
  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="shrink-0 font-medium">{step.name}</span>
      <span className="min-w-0 flex-1 truncate text-right text-2xs text-muted-foreground">
        {meta}
      </span>
    </span>
  );
  const leading = (
    <span className="w-4 text-center text-2xs tabular-nums">{index + 1}</span>
  );
  return (
    <li data-definition-step={step.name}>
      {details ? (
        <ListRow
          leading={leading}
          title={title}
          trailing={
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-3.5 transition-transform duration-base ease-out',
                open && 'rotate-180',
              )}
            />
          }
          onClick={() => setOpen(value => !value)}
          mainProps={{ 'aria-expanded': open, title: meta }}
        />
      ) : (
        <ListRow leading={leading} title={title} />
      )}
      {open && (
        <div className="space-y-1.5 pt-1 pr-2 pb-2 pl-8">
          {step.body.trim() && (
            <CodeBlock
              code={step.body.trim()}
              wrap
              maxHeightClassName="max-h-40"
            />
          )}
          {step.notes.map(note => (
            <p key={note} className="text-2xs text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      )}
    </li>
  );
}

function WorkflowDetail({ workflow }: { workflow: ResolvedWorkflow }) {
  const phases = phaseOrder
    .map(phase => ({
      phase,
      steps: workflow.steps
        .map((step, index) => ({ step, index }))
        .filter(item => item.step.phase === phase),
    }))
    .filter(group => group.steps.length > 0);
  return (
    <section
      aria-label={`${workflow.name} steps`}
      className="min-w-0 divide-y rounded-surface border"
    >
      <div className="space-y-0.5 px-3 py-3">
        <h3 className="text-ui font-semibold">{workflow.name}</h3>
        {workflow.description && (
          <p className="text-xs leading-5 text-muted-foreground">
            {workflow.description}
          </p>
        )}
        <p className="truncate font-mono text-2xs text-muted-foreground">
          {scopeLabels[workflow.source.scope]} · {workflow.source.path}
        </p>
        {workflow.notes.map(note => (
          <p key={note} className="text-2xs text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
      {phases.map(group => (
        <div key={group.phase} className="p-1">
          <SectionLabel as="h4" count={group.steps.length}>
            {phaseLabels[group.phase]}
          </SectionLabel>
          <ol className="space-y-px">
            {group.steps.map(({ step, index }) => (
              <DefinitionStep key={step.name} step={step} index={index} />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

export default function WorkflowDefinitions({
  computers,
  hostId: initialHostId,
  directory: initialDirectory,
  api,
  onEdit,
  onCreate,
  refreshToken = 0,
  highlighted = [],
  onSourceChange,
}: Props) {
  const [hostId, setHostId] = useState(initialHostId);
  const [directory, setDirectory] = useState(initialDirectory);
  const initialConnected =
    computers.find(item => item.id === initialHostId)?.status === 'connected';
  const [state, setState] = useState<CatalogState>(
    initialConnected ? { status: 'loading' } : { status: 'idle' },
  );
  const [selectedName, setSelectedName] = useState('');
  const [reviewed, setReviewed] = useState<string[]>([]);
  const request = useRef(0);
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  const load = (targetHost: string, targetDirectory: string) => {
    onSourceChange?.({ hostId: targetHost, directory: targetDirectory.trim() });
    const current = ++request.current;
    if (
      computers.find(item => item.id === targetHost)?.status !== 'connected'
    ) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    api.listDefinitions(targetHost, { directory: targetDirectory.trim() }).then(
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
  const initial = useRef({
    hostId: initialHostId,
    directory: initialDirectory,
    connected: initialConnected,
  });
  useEffect(() => {
    if (!initial.current.connected) return;
    const current = ++request.current;
    api
      .listDefinitions(initial.current.hostId, {
        directory: initial.current.directory.trim(),
      })
      .then(
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
  }, [api]);
  const seenToken = useRef(refreshToken);
  useEffect(() => {
    if (seenToken.current === refreshToken) return;
    seenToken.current = refreshToken;
    load(hostId, directory);
  });
  const catalog = state.status === 'loaded' ? state.catalog : null;
  const selected =
    catalog?.workflows.find(workflow => workflow.name === selectedName) ??
    catalog?.workflows[0];
  return (
    <section
      aria-label="Workflows"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-5xl space-y-4 px-5 py-6 lg:px-8">
        <div className="flex items-center justify-between gap-3 px-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {!catalog
              ? 'Workflows are read from the files on the chosen computer'
              : catalog.workflows.length === 0
                ? 'No workflows'
                : `${catalog.workflows.length} ${catalog.workflows.length === 1 ? 'workflow' : 'workflows'} · ${catalog.steps.length} ${catalog.steps.length === 1 ? 'step' : 'steps'}${catalog.issues.length ? ` · ${catalog.issues.length} ${catalog.issues.length === 1 ? 'issue' : 'issues'}` : ''}`}
          </span>
          {onCreate && (
            <Button
              type="button"
              variant="ghost"
              disabled={!connected}
              title={
                connected
                  ? undefined
                  : 'Connect the computer to create a workflow.'
              }
              onClick={() => onCreate({ hostId, directory })}
            >
              <Plus />
              New workflow
            </Button>
          )}
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            load(hostId, directory);
          }}
        >
          <Field id="workflows-computer" label="Computer">
            <div>
              <Select
                value={hostId}
                onValueChange={value => {
                  setHostId(value);
                  load(value, directory);
                }}
              >
                <SelectTrigger
                  id="workflows-computer"
                  size="md"
                  className="w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {computers.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                      {item.status === 'connected' ? '' : ' · Offline'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>
          <Field
            id="workflows-directory"
            label="Project folder"
            className="min-w-48 flex-1"
          >
            <Input
              size="md"
              id="workflows-directory"
              placeholder="Absolute path, or blank for global definitions"
              value={directory}
              maxLength={4096}
              onChange={event => setDirectory(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            size="md"
            disabled={!connected || state.status === 'loading'}
          >
            <RefreshCw
              className={cn(
                state.status === 'loading' &&
                  'animate-spin motion-reduce:animate-none',
              )}
            />
            Read
          </Button>
        </form>
        {!connected && (
          <p className="text-xs text-muted-foreground">
            {computer?.name ?? 'This computer'} is offline. Connect it to read
            its workflows.
          </p>
        )}
        {state.status === 'loading' && (
          <StatusMessage tone="loading">Reading workflows…</StatusMessage>
        )}
        {state.status === 'error' && (
          <StatusMessage tone="error">{state.message}</StatusMessage>
        )}
        {catalog && (
          <>
            <p className="space-x-3 text-2xs text-muted-foreground">
              <span>Global: {catalog.roots.global ?? 'none'}</span>
              <span>Project: {catalog.roots.project ?? 'none'}</span>
            </p>
            <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
              <ul
                aria-label="Workflow definitions"
                className="h-fit min-w-0 space-y-px rounded-surface border p-1"
              >
                {catalog.workflows.map(workflow => {
                  const count = workflowIssueCount(catalog, workflow);
                  const active = selected?.name === workflow.name;
                  return (
                    <li key={workflow.name}>
                      <ListRow
                        data-definition={workflow.name}
                        selected={active}
                        leading={<Workflow aria-hidden="true" />}
                        title={
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium">
                              {workflow.name}
                            </span>
                            {highlighted.includes(workflow.name) &&
                              !reviewed.includes(workflow.name) && (
                                <AddedByAssistantBadge />
                              )}
                          </span>
                        }
                        trailing={
                          <>
                            {count > 0 && (
                              <span className="text-warning-foreground">
                                {count} {count === 1 ? 'issue' : 'issues'}
                              </span>
                            )}
                            <span>
                              {workflow.steps.length}{' '}
                              {workflow.steps.length === 1 ? 'step' : 'steps'}
                            </span>
                          </>
                        }
                        actions={
                          onEdit && (
                            <IconButton
                              size={24}
                              label={`Edit ${workflow.name}`}
                              onClick={() =>
                                onEdit({
                                  hostId,
                                  directory,
                                  workflowName: workflow.name,
                                  catalog,
                                })
                              }
                            >
                              <SquarePen />
                            </IconButton>
                          )
                        }
                        onClick={() => {
                          setSelectedName(workflow.name);
                          setReviewed(current =>
                            current.includes(workflow.name)
                              ? current
                              : [...current, workflow.name],
                          );
                        }}
                        mainProps={{
                          'aria-pressed': active,
                          'aria-current': undefined,
                          title:
                            [workflow.description, phaseCounts(workflow)]
                              .filter(Boolean)
                              .join(' · ') || undefined,
                        }}
                      />
                    </li>
                  );
                })}
                {catalog.workflows.length === 0 && (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground">
                    No valid workflows in this folder or the global folder.
                  </li>
                )}
              </ul>
              {selected ? (
                <WorkflowDetail workflow={selected} />
              ) : (
                <EmptyState
                  icon={Workflow}
                  title="No workflows yet"
                  description="A workflow is a graph of checks, agents, approvals and actions that runs on a task. Build one in the graph editor."
                  className="min-h-64"
                  action={
                    onCreate && (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!connected}
                        onClick={() => onCreate({ hostId, directory })}
                      >
                        New workflow
                      </Button>
                    )
                  }
                />
              )}
            </div>
            {catalog.issues.length > 0 && (
              <section aria-label="Validation issues" className="space-y-1">
                <SectionLabel>
                  {catalog.issues.length} validation{' '}
                  {catalog.issues.length === 1 ? 'issue' : 'issues'}
                </SectionLabel>
                <ul className="space-y-px rounded-surface border p-1">
                  {catalog.issues.map((issue, index) => {
                    const error = issue.severity === 'error';
                    return (
                      <li
                        key={index}
                        className="flex min-h-7 min-w-0 items-start gap-2 px-2 py-1 text-xs"
                      >
                        <StatusIcon
                          status={error ? 'error' : 'warning'}
                          label={error ? 'Error' : 'Warning'}
                          className="mt-1"
                        />
                        <span className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">
                          {issue.message}
                        </span>
                        <Hint label={issue.path}>
                          <span className="max-w-48 shrink-0 truncate font-mono text-2xs leading-5 text-muted-foreground">
                            {issueScope(catalog, issue)} ·{' '}
                            {fileName(issue.path)}
                            {issue.line ? `:${issue.line}` : ''}
                          </span>
                        </Hint>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
