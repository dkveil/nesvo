import { useEffect, useRef, useState } from 'react';
import type { Computer, PipelinesApi } from '@nesvo/contracts';
import { RefreshCw, Workflow } from 'lucide-react';
import { cn } from 'cn';
import {
  phaseLabels,
  phaseOrder,
  type DefinitionCatalog,
  type DefinitionIssue,
  type ResolvedPipeline,
} from '@/entities/pipeline';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

type Props = {
  computers: Computer[];
  hostId: string;
  directory: string;
  api: Pick<PipelinesApi, 'listDefinitions'>;
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

const phaseCounts = (pipeline: ResolvedPipeline) =>
  phaseOrder
    .map(phase => ({
      phase,
      count: pipeline.steps.filter(step => step.phase === phase).length,
    }))
    .filter(item => item.count > 0)
    .map(item => `${phaseLabels[item.phase]} ${item.count}`)
    .join(' · ');

const pipelineIssueCount = (
  catalog: DefinitionCatalog,
  pipeline: ResolvedPipeline,
) => {
  const paths = new Set(
    [pipeline.source.path, ...pipeline.steps.map(step => step.source.path)].map(
      normalized,
    ),
  );
  return catalog.issues.filter(issue => paths.has(normalized(issue.path)))
    .length;
};

function PipelineDetail({ pipeline }: { pipeline: ResolvedPipeline }) {
  return (
    <section
      aria-label={`${pipeline.name} steps`}
      className="min-w-0 space-y-3"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{pipeline.name}</h3>
        {pipeline.description && (
          <p className="text-xs leading-5 text-muted-foreground">
            {pipeline.description}
          </p>
        )}
        <p
          className="truncate font-mono text-2xs text-muted-foreground"
          title={pipeline.source.path}
        >
          {scopeLabels[pipeline.source.scope]} · {pipeline.source.path}
        </p>
        {pipeline.notes.map(note => (
          <p key={note} className="text-2xs text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
      <ol className="space-y-1.5">
        {pipeline.steps.map((step, index) => (
          <li
            key={step.name}
            data-definition-step={step.name}
            className="space-y-1.5 rounded-lg border px-3 py-2.5"
          >
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-2xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="text-[13px] font-medium">{step.name}</span>
              <span className="text-2xs text-muted-foreground">
                {[
                  step.type[0]!.toUpperCase() + step.type.slice(1),
                  phaseLabels[step.phase],
                  step.skill ? `Skill ${step.skill}` : '',
                  `Timeout ${step.timeout}`,
                  step.retries ? `Retries ${step.retries}` : '',
                  step.on_fail === 'fix' ? 'Sends failures back for a fix' : '',
                  step.needs.length ? `Needs ${step.needs.join(', ')}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="ml-auto text-2xs text-muted-foreground">
                {scopeLabels[step.source.scope]}
              </span>
            </div>
            {step.body.trim() && (
              <pre className="max-h-32 overflow-auto rounded-md bg-code-background px-2.5 py-2 font-mono text-2xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {step.body.trim()}
              </pre>
            )}
            {step.notes.map(note => (
              <p key={note} className="text-2xs text-muted-foreground">
                {note}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function PipelineDefinitions({
  computers,
  hostId: initialHostId,
  directory: initialDirectory,
  api,
}: Props) {
  const [hostId, setHostId] = useState(initialHostId);
  const [directory, setDirectory] = useState(initialDirectory);
  const initialConnected =
    computers.find(item => item.id === initialHostId)?.status === 'connected';
  const [state, setState] = useState<CatalogState>(
    initialConnected ? { status: 'loading' } : { status: 'idle' },
  );
  const [selectedName, setSelectedName] = useState('');
  const request = useRef(0);
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  const load = (targetHost: string, targetDirectory: string) => {
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
            message: `Could not read pipelines. ${errorDetail(failure)}`,
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
              message: `Could not read pipelines. ${errorDetail(failure)}`,
            });
        },
      );
  }, [api]);
  const catalog = state.status === 'loaded' ? state.catalog : null;
  const selected =
    catalog?.pipelines.find(pipeline => pipeline.name === selectedName) ??
    catalog?.pipelines[0];
  return (
    <section
      aria-label="Pipelines"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-5xl space-y-5 px-5 py-6">
        <header className="space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Workflow
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            Pipelines
          </h2>
          <p className="text-xs text-muted-foreground">
            Definitions read from the files on the chosen computer. Read-only;
            edit the files to change a pipeline.
          </p>
        </header>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            load(hostId, directory);
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="pipelines-computer" className="text-2xs">
              Computer
            </Label>
            <Select
              value={hostId}
              onValueChange={value => {
                setHostId(value);
                load(value, directory);
              }}
            >
              <SelectTrigger
                id="pipelines-computer"
                size="sm"
                className="h-8 w-44 text-xs"
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
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="pipelines-directory" className="text-2xs">
              Project folder
            </Label>
            <Input
              id="pipelines-directory"
              placeholder="Absolute path, or blank for global definitions"
              value={directory}
              maxLength={4096}
              onChange={event => setDirectory(event.target.value)}
              className="h-8 text-xs md:text-xs"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="h-8"
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
            its pipelines.
          </p>
        )}
        {state.status === 'loading' && (
          <p role="status" className="text-xs text-muted-foreground">
            Reading pipelines…
          </p>
        )}
        {state.status === 'error' && (
          <p
            role="alert"
            className="text-xs text-destructive [overflow-wrap:anywhere]"
          >
            {state.message}
          </p>
        )}
        {catalog && (
          <>
            <p className="space-x-3 text-2xs text-muted-foreground">
              <span title={catalog.roots.global ?? undefined}>
                Global: {catalog.roots.global ?? 'none'}
              </span>
              <span title={catalog.roots.project ?? undefined}>
                Project: {catalog.roots.project ?? 'none'}
              </span>
            </p>
            <div className="grid gap-5 md:grid-cols-[17rem_minmax(0,1fr)]">
              <ul
                aria-label="Pipeline definitions"
                className="min-w-0 space-y-0.5"
              >
                {catalog.pipelines.map(pipeline => {
                  const count = pipelineIssueCount(catalog, pipeline);
                  const active = selected?.name === pipeline.name;
                  return (
                    <li key={pipeline.name}>
                      <button
                        type="button"
                        aria-pressed={active}
                        data-definition={pipeline.name}
                        onClick={() => setSelectedName(pipeline.name)}
                        className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors duration-100 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-highlight"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[13px] font-medium">
                            {pipeline.name}
                          </span>
                          <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                            {scopeLabels[pipeline.source.scope]}
                          </span>
                        </span>
                        {pipeline.description && (
                          <span className="line-clamp-2 text-2xs leading-4 text-muted-foreground">
                            {pipeline.description}
                          </span>
                        )}
                        <span className="text-2xs text-muted-foreground">
                          {phaseCounts(pipeline)}
                          {count > 0 && (
                            <span className="text-warning-foreground">
                              {' '}
                              · {count} {count === 1 ? 'issue' : 'issues'}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {catalog.pipelines.length === 0 && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">
                    No valid pipelines in this folder or the global folder.
                  </li>
                )}
              </ul>
              {selected && <PipelineDetail pipeline={selected} />}
            </div>
            {catalog.issues.length > 0 && (
              <section aria-label="Validation issues" className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {catalog.issues.length} validation{' '}
                  {catalog.issues.length === 1 ? 'issue' : 'issues'}
                </h3>
                <ul className="divide-y rounded-lg border">
                  {catalog.issues.map((issue, index) => (
                    <li
                      key={index}
                      className="flex min-w-0 items-start gap-3 px-3 py-2 text-xs"
                    >
                      <span
                        className={cn(
                          'w-14 shrink-0 font-medium',
                          issue.severity === 'error'
                            ? 'text-error-foreground'
                            : 'text-warning-foreground',
                        )}
                      >
                        {issue.severity === 'error' ? 'Error' : 'Warning'}
                      </span>
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="block leading-5 [overflow-wrap:anywhere]">
                          {issue.message}
                        </span>
                        <span
                          className="block truncate font-mono text-2xs text-muted-foreground"
                          title={issue.path}
                        >
                          {issueScope(catalog, issue)} · {fileName(issue.path)}
                          {issue.line ? `:${issue.line}` : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
