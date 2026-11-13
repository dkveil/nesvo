import { useRef, useState } from 'react';
import { Check, RefreshCw, Workflow } from 'lucide-react';
import { cn } from 'cn';
import type { DefinitionCatalog, PipelinesApi } from '@nesvo/contracts';
import {
  errorDetail,
  modelLabel,
  ProviderGlyph,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Switch } from '@/shared/ui/switch';
import { ComposerChip } from './composer-chip';
import { pipelineIssues, type PipelineChoice } from './pipeline-choice';

type Props = {
  hostId: string;
  directory: string;
  connected: boolean;
  authorProvider: Provider;
  statuses: ProviderStates;
  api: Pick<PipelinesApi, 'listDefinitions'>;
  value: PipelineChoice | null;
  disabled?: boolean;
  onChange: (value: PipelineChoice | null) => void;
};

type CatalogState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; catalog: DefinitionCatalog };

const otherProvider = (provider: Provider): Provider =>
  provider === 'Codex' ? 'Claude Code' : 'Codex';

const gateModels = (statuses: ProviderStates, provider: Provider) => {
  const models = statuses[provider].status?.models ?? [];
  return models.length > 0
    ? models.map(model => ({ id: model.id, label: model.label }))
    : [{ id: 'default', label: 'Default' }];
};

const specName = (path: string) =>
  path.split(/[\\/]/).at(-1)?.replace(/\.md$/i, '') ?? path;

const optionRow =
  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-100 hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset aria-checked:bg-highlight';

export function PipelinePicker({
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
            message: `Could not read pipelines. ${errorDetail(failure)}`,
          });
      },
    );
  };
  const catalog = state.status === 'loaded' ? state.catalog : null;
  const defaultGate = otherProvider(authorProvider);
  const choose = (changes: Partial<PipelineChoice>) => {
    const base: PipelineChoice = value ?? {
      pipelineName: '',
      specPath: '',
      specTitle: null,
      isolation: !!trimmed,
      gateProvider: defaultGate,
      gateModel: gateModels(statuses, defaultGate)[0]!.id,
    };
    onChange({ ...base, ...changes });
  };
  const selectedPipeline = catalog?.pipelines.find(
    pipeline => pipeline.name === value?.pipelineName,
  );
  const isolationReason = !trimmed
    ? 'Choose a project folder to isolate the task.'
    : '';
  const gateProvider = value?.gateProvider ?? defaultGate;
  const models = gateModels(statuses, gateProvider);
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) load();
      }}
    >
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Pipeline"
          data-pipeline={value?.pipelineName || undefined}
          title={
            value?.pipelineName
              ? `Pipeline: ${value.pipelineName}${value.specPath ? ` · ${specName(value.specPath)}` : ''}`
              : 'Run this task through a pipeline'
          }
          className={cn(value?.pipelineName && 'text-foreground')}
        >
          <Workflow />
          <span className="truncate">{value?.pipelineName || 'Pipeline'}</span>
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Pipeline"
        className="flex max-h-[min(34rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1.5rem))] flex-col gap-3 overflow-y-auto p-2.5"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs font-medium text-muted-foreground">Pipeline</p>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground"
            aria-label="Refresh pipelines"
            title="Refresh pipelines"
            disabled={!connected || state.status === 'loading'}
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
        {!connected && (
          <p className="px-1 text-xs text-muted-foreground">
            Connect this computer to list its pipelines.
          </p>
        )}
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
            Reading pipelines…
          </p>
        )}
        {catalog && (
          <div role="radiogroup" aria-label="Pipelines" className="space-y-0.5">
            <button
              type="button"
              role="radio"
              aria-checked={!value?.pipelineName}
              className={optionRow}
              onClick={() => onChange(null)}
            >
              <Check
                className={cn(
                  'mt-0.5 size-3.5 shrink-0',
                  value?.pipelineName && 'invisible',
                )}
                aria-hidden="true"
              />
              <span className="flex-1 text-[13px]">No pipeline</span>
            </button>
            {catalog.pipelines.map(pipeline => {
              const issues = pipelineIssues(catalog, pipeline.name, '');
              const checked = value?.pipelineName === pipeline.name;
              return (
                <button
                  key={pipeline.name}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-pipeline-option={pipeline.name}
                  className={optionRow}
                  onClick={() => {
                    const spec = catalog.specs.find(
                      item => item.source.path === value?.specPath,
                    );
                    const firstSpec = catalog.specs.find(
                      item => item.pipeline === pipeline.name,
                    );
                    const keep =
                      !!value?.specPath &&
                      (!spec || spec.pipeline === pipeline.name);
                    choose({
                      pipelineName: pipeline.name,
                      specPath: keep
                        ? value!.specPath
                        : (firstSpec?.source.path ?? ''),
                      specTitle: keep
                        ? value!.specTitle
                        : (firstSpec?.title ?? null),
                    });
                  }}
                >
                  <Check
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0',
                      !checked && 'invisible',
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">
                        {pipeline.name}
                      </span>
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {pipeline.steps.length} steps
                      </span>
                      {issues.length > 0 && (
                        <span className="shrink-0 text-2xs text-warning-foreground">
                          {issues.length}{' '}
                          {issues.length === 1 ? 'issue' : 'issues'}
                        </span>
                      )}
                    </span>
                    {pipeline.description && (
                      <span className="mt-0.5 line-clamp-2 block text-2xs leading-4 text-muted-foreground">
                        {pipeline.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {catalog.pipelines.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No pipelines in .agents/pipelines for this folder.
              </p>
            )}
            {catalog.issues.length > 0 && (
              <details className="px-2 pt-1 text-2xs text-muted-foreground">
                <summary className="cursor-pointer text-warning-foreground">
                  {catalog.issues.length} definition{' '}
                  {catalog.issues.length === 1 ? 'issue' : 'issues'}
                </summary>
                <ul className="mt-1.5 space-y-1.5 leading-4">
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
              </details>
            )}
          </div>
        )}
        {value?.pipelineName && (
          <>
            <div className="space-y-1 border-t pt-2.5">
              <p className="px-1 text-xs font-medium text-muted-foreground">
                Task spec
              </p>
              {catalog && catalog.specs.length > 0 && (
                <div
                  role="radiogroup"
                  aria-label="Task specs"
                  className="space-y-0.5"
                >
                  {catalog.specs.map(spec => {
                    const checked = value.specPath === spec.source.path;
                    return (
                      <button
                        key={spec.source.path}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        className={optionRow}
                        onClick={() =>
                          choose({
                            specPath: spec.source.path,
                            specTitle: spec.title,
                            pipelineName: spec.pipeline,
                          })
                        }
                      >
                        <Check
                          className={cn(
                            'mt-0.5 size-3.5 shrink-0',
                            !checked && 'invisible',
                          )}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">
                            {spec.title ?? specName(spec.source.path)}
                          </span>
                          <span className="block truncate text-2xs text-muted-foreground">
                            {specName(spec.source.path)}.md · {spec.pipeline}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="space-y-1 px-1 pt-1">
                <Label htmlFor="pipeline-spec-path" className="text-2xs">
                  Spec path
                </Label>
                <Input
                  id="pipeline-spec-path"
                  placeholder="Path to a Markdown spec in this project"
                  value={value.specPath}
                  maxLength={4096}
                  onChange={event =>
                    choose({ specPath: event.target.value, specTitle: null })
                  }
                  className="h-7 px-2 text-xs md:text-xs"
                />
              </div>
            </div>
            <div className="space-y-1 border-t px-1 pt-2.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="pipeline-isolation" className="text-xs">
                  Isolate in a worktree
                </Label>
                <Switch
                  id="pipeline-isolation"
                  checked={value.isolation && !isolationReason}
                  disabled={!!isolationReason}
                  onCheckedChange={checked => choose({ isolation: checked })}
                />
              </div>
              <p className="text-2xs leading-4 text-muted-foreground">
                {isolationReason ||
                  'A new branch and worktree from the repository top folder. Nothing is pushed or merged.'}
              </p>
            </div>
            <div className="space-y-1.5 border-t px-1 pt-2.5">
              <p className="text-xs font-medium text-muted-foreground">Gates</p>
              <div className="flex items-center gap-2">
                <div
                  role="radiogroup"
                  aria-label="Gate provider"
                  className="grid shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-segment-track p-0.5"
                >
                  {providers.map(provider => (
                    <button
                      key={provider}
                      type="button"
                      role="radio"
                      aria-checked={gateProvider === provider}
                      title={provider}
                      onClick={() =>
                        choose({
                          gateProvider: provider,
                          gateModel: gateModels(statuses, provider)[0]!.id,
                        })
                      }
                      className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-checked:bg-segment-active aria-checked:text-foreground"
                    >
                      <ProviderGlyph provider={provider} />
                      {provider}
                    </button>
                  ))}
                </div>
                <Select
                  value={value.gateModel}
                  onValueChange={gateModel => choose({ gateModel })}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Gate model"
                    className="h-7 min-w-0 flex-1 text-xs"
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
              <p className="text-2xs leading-4 text-muted-foreground">
                Agent gates run read-only in a fresh session
                {gateProvider !== authorProvider
                  ? ', on a different provider than the author.'
                  : '.'}
              </p>
            </div>
            {selectedPipeline && (
              <p className="border-t px-1 pt-2.5 text-2xs leading-4 text-muted-foreground">
                {selectedPipeline.steps.map(step => step.name).join(' → ')}
              </p>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
