import { useId, useState } from 'react';
import { Play } from 'lucide-react';
import type { StartWorkflowTaskInput, TaskSpecSummary } from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { ModelPicker } from '@/features/new-thread/model-picker';
import {
  modelEfforts,
  resolveEffort,
} from '@/features/new-thread/reasoning-effort';
import { resolveGate } from '@/features/new-thread/workflow-choice';
import { Button } from '@/shared/ui/button';
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

type Props = {
  workflowName: string;
  directory: string;
  specs: TaskSpecSummary[];
  statuses: ProviderStates;
  blockedReason: string | null;
  onRefreshProvider: (provider: Provider) => void;
  onRun: (input: StartWorkflowTaskInput) => Promise<void>;
};

type Pick = { provider: Provider; model: string; effort: string };

const specLabel = (spec: TaskSpecSummary) =>
  spec.title ?? spec.source.path.split(/[\\/]/).at(-1) ?? spec.source.path;

const readyProvider = (statuses: ProviderStates): Provider =>
  providers.find(provider => statuses[provider].status?.status === 'ready') ??
  'Codex';

const initialPick = (statuses: ProviderStates): Pick => {
  const provider = readyProvider(statuses);
  const model = statuses[provider].status?.models[0]?.id ?? '';
  return {
    provider,
    model,
    effort: resolveEffort(modelEfforts(statuses[provider], model), ''),
  };
};

export function RunPopover({
  workflowName,
  directory,
  specs,
  statuses,
  blockedReason,
  onRefreshProvider,
  onRun,
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [specPath, setSpecPath] = useState('');
  const [pick, setPick] = useState<Pick | null>(null);
  const [isolation, setIsolation] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState('');
  const mine = specs.filter(spec => spec.workflow === workflowName);
  const chosenSpec =
    mine.find(spec => spec.source.path === specPath) ?? mine[0] ?? null;
  const current = pick ?? initialPick(statuses);
  const providerReady =
    statuses[current.provider].status?.status === 'ready' && !!current.model;
  const gate = resolveGate(null, current.provider, statuses);
  const reason =
    blockedReason ??
    (!chosenSpec
      ? 'No task spec names this workflow. Add one in .agents/tasks with a workflow field.'
      : !providerReady
        ? `${current.provider} is not ready on this computer.`
        : null);
  const start = async () => {
    if (!chosenSpec || reason) return;
    setStarting(true);
    setFailure('');
    const effort = resolveEffort(
      modelEfforts(statuses[current.provider], current.model),
      current.effort,
    );
    const input: StartWorkflowTaskInput = {
      specPath: chosenSpec.source.path,
      workflowName,
      provider: current.provider,
      model: current.model,
      ...(effort ? { effort } : {}),
      mode: 'read-only',
      directory,
      isolation: isolation ? 'worktree' : 'none',
      gateProvider: gate.provider,
      gateModel: gate.model,
    };
    try {
      await onRun(input);
      setOpen(false);
    } catch (error) {
      setFailure(errorDetail(error));
    } finally {
      setStarting(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          aria-label="Run workflow"
          title="Start a task through this workflow"
        >
          <Play />
          Run
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 space-y-3 p-3"
        aria-label="Run workflow"
      >
        <div className="space-y-1">
          <h3 className="text-xs font-semibold">Run {workflowName}</h3>
          <p className="text-2xs leading-4 text-muted-foreground">
            Starts one task session from a spec. The author works read-only; the
            checks run when its turn ends.
          </p>
        </div>
        <div className="space-y-1">
          <Label
            htmlFor={`${id}-spec`}
            className="text-2xs text-muted-foreground"
          >
            Task spec
          </Label>
          <Select
            value={chosenSpec?.source.path ?? ''}
            onValueChange={setSpecPath}
            disabled={mine.length === 0}
          >
            <SelectTrigger
              id={`${id}-spec`}
              size="md"
              className="w-full text-xs"
            >
              <SelectValue placeholder="No spec for this workflow" />
            </SelectTrigger>
            <SelectContent>
              {mine.map(spec => (
                <SelectItem
                  key={spec.source.path}
                  value={spec.source.path}
                  className="text-xs"
                >
                  {specLabel(spec)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-2xs text-muted-foreground">Author</span>
          <div className="flex items-center gap-2">
            <ModelPicker
              provider={current.provider}
              model={current.model}
              effort={current.effort}
              statuses={statuses}
              onChange={(provider, model, effort) =>
                setPick({ provider, model, effort })
              }
              onRefreshProvider={onRefreshProvider}
            />
            <span className="min-w-0 truncate text-2xs text-muted-foreground">
              Gate: {gate.provider}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${id}-isolation`} className="text-xs">
            Isolate in a Git worktree
          </Label>
          <Switch
            id={`${id}-isolation`}
            checked={isolation}
            onCheckedChange={setIsolation}
          />
        </div>
        {(reason || failure) && (
          <p
            role={failure ? 'alert' : 'status'}
            className="text-2xs leading-4 text-muted-foreground [overflow-wrap:anywhere]"
          >
            {failure || reason}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            className="h-7"
            disabled={!!reason || starting}
            onClick={() => void start()}
          >
            <Play />
            {starting ? 'Starting…' : 'Start task'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
