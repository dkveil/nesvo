import { useEffect, useRef, useState } from 'react';
import type { Computer, PipelinesApi } from '@nesvo/contracts';
import {
  ChevronDown,
  CircleX,
  Plus,
  RefreshCw,
  SquarePen,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { cn } from 'cn';
import {
  phaseLabels,
  phaseOrder,
  type DefinitionCatalog,
  type DefinitionIssue,
  type ResolvedPipeline,
  type ResolvedStep,
} from '@/entities/pipeline';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  cardIcon,
  cardIconButton,
  cardRow,
  cardRowAction,
  cardSection,
  cardSectionHeader,
  cardSurface,
  cardValue,
} from '@/shared/ui/card-row-styles';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

export type EditorTarget = {
  hostId: string;
  directory: string;
  pipelineName: string | null;
  catalog: DefinitionCatalog;
};

type Props = {
  computers: Computer[];
  hostId: string;
  directory: string;
  api: Pick<PipelinesApi, 'listDefinitions'>;
  onEdit?: (target: EditorTarget) => void;
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
  const row = (
    <>
      <span className="w-4 shrink-0 text-center text-2xs text-muted-foreground tabular-nums">
        {index + 1}
      </span>
      <span className="min-w-0 shrink-0 truncate">{step.name}</span>
      <span className="min-w-0 flex-1 truncate text-right text-2xs font-normal text-muted-foreground">
        {meta}
      </span>
    </>
  );
  return (
    <li data-definition-step={step.name}>
      {details ? (
        <button
          type="button"
          aria-expanded={open}
          title={meta}
          onClick={() => setOpen(value => !value)}
          className={cardRowAction}
        >
          {row}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </button>
      ) : (
        <div title={meta} className={cardRow}>
          {row}
        </div>
      )}
      {open && (
        <div className="space-y-1.5 pt-1 pr-2.5 pb-2 pl-9">
          {step.body.trim() && (
            <pre className="max-h-40 overflow-auto rounded-md bg-code-background px-2.5 py-2 font-mono text-2xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {step.body.trim()}
            </pre>
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

function PipelineDetail({ pipeline }: { pipeline: ResolvedPipeline }) {
  const phases = phaseOrder
    .map(phase => ({
      phase,
      steps: pipeline.steps
        .map((step, index) => ({ step, index }))
        .filter(item => item.step.phase === phase),
    }))
    .filter(group => group.steps.length > 0);
  return (
    <section
      aria-label={`${pipeline.name} steps`}
      className={cn(cardSurface, 'min-w-0 divide-y')}
    >
      <div className="space-y-0.5 px-4 py-3">
        <h3 className="text-[13px] font-semibold">{pipeline.name}</h3>
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
      {phases.map(group => (
        <div key={group.phase} className={cardSection}>
          <h4 className={cardSectionHeader}>
            {phaseLabels[group.phase]} · {group.steps.length}
          </h4>
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

export default function PipelineDefinitions({
  computers,
  hostId: initialHostId,
  directory: initialDirectory,
  api,
  onEdit,
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
          <div className="flex items-center gap-2">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Workflow
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              Pipelines
            </h2>
            {onEdit && catalog && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto h-7"
                onClick={() =>
                  onEdit({ hostId, directory, pipelineName: null, catalog })
                }
              >
                <Plus />
                New pipeline
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Definitions read from the files on the chosen computer. Edit opens a
            pipeline in the graph editor, which writes the files back.
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
            <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
              <ul
                aria-label="Pipeline definitions"
                className={cn(cardSurface, 'h-fit min-w-0 space-y-px p-1.5')}
              >
                {catalog.pipelines.map(pipeline => {
                  const count = pipelineIssueCount(catalog, pipeline);
                  const active = selected?.name === pipeline.name;
                  return (
                    <li
                      key={pipeline.name}
                      className="flex items-center gap-0.5"
                    >
                      <button
                        type="button"
                        aria-pressed={active}
                        data-definition={pipeline.name}
                        title={[pipeline.description, phaseCounts(pipeline)]
                          .filter(Boolean)
                          .join(' · ')}
                        onClick={() => setSelectedName(pipeline.name)}
                        className={cn(
                          cardRowAction,
                          'min-w-0 flex-1 aria-pressed:bg-highlight',
                        )}
                      >
                        <Workflow className={cardIcon} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">
                          {pipeline.name}
                        </span>
                        {count > 0 && (
                          <span className="shrink-0 text-2xs font-normal text-warning-foreground tabular-nums">
                            {count} {count === 1 ? 'issue' : 'issues'}
                          </span>
                        )}
                        <span className={cardValue}>
                          {pipeline.steps.length}{' '}
                          {pipeline.steps.length === 1 ? 'step' : 'steps'}
                        </span>
                      </button>
                      {onEdit && (
                        <button
                          type="button"
                          aria-label={`Edit ${pipeline.name}`}
                          title="Edit in the graph editor"
                          onClick={() =>
                            onEdit({
                              hostId,
                              directory,
                              pipelineName: pipeline.name,
                              catalog,
                            })
                          }
                          className={cardIconButton}
                        >
                          <SquarePen className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
                {catalog.pipelines.length === 0 && (
                  <li className="px-2.5 py-1.5 text-xs text-muted-foreground">
                    No valid pipelines in this folder or the global folder.
                  </li>
                )}
              </ul>
              {selected && <PipelineDetail pipeline={selected} />}
            </div>
            {catalog.issues.length > 0 && (
              <section aria-label="Validation issues" className="space-y-2">
                <h3 className="px-1 text-2xs text-muted-foreground">
                  {catalog.issues.length} validation{' '}
                  {catalog.issues.length === 1 ? 'issue' : 'issues'}
                </h3>
                <ul className={cn(cardSurface, 'space-y-px p-1.5')}>
                  {catalog.issues.map((issue, index) => {
                    const error = issue.severity === 'error';
                    const Icon = error ? CircleX : TriangleAlert;
                    return (
                      <li
                        key={index}
                        className="flex min-h-7 min-w-0 items-start gap-2.5 rounded-md px-2.5 py-1 text-xs"
                      >
                        <Icon
                          role="img"
                          aria-label={error ? 'Error' : 'Warning'}
                          className={cn(
                            'mt-0.5 size-4 shrink-0',
                            error
                              ? 'text-error-foreground'
                              : 'text-warning-foreground',
                          )}
                        />
                        <span className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">
                          {issue.message}
                        </span>
                        <span
                          className="max-w-48 shrink-0 truncate font-mono text-2xs leading-5 text-muted-foreground"
                          title={issue.path}
                        >
                          {issueScope(catalog, issue)} · {fileName(issue.path)}
                          {issue.line ? `:${issue.line}` : ''}
                        </span>
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
