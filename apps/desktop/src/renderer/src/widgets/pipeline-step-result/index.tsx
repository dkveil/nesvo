import { useEffect, useRef, useState } from 'react';
import type { PipelinesApi } from '@nesvo/contracts';
import {
  ExternalLink,
  FileText,
  Inbox,
  Link,
  MessageSquare,
  ScrollText,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { errorDetail } from '@/entities/session';
import {
  formatDuration,
  phaseLabels,
  pipelineSteps,
  stepStateLabels,
  stepStateTones,
  toneText,
  type Evidence,
  type PipelineEvidence,
  type PipelineRun,
  type PipelineStepRecord,
} from '@/entities/pipeline';
import { StepStateIcon } from '@/entities/pipeline/step-state-icon';
import { hostKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { PanelAction, PanelHeader } from '@/shared/ui/panel';
import { panelSurface } from '@/shared/ui/panel-styles';

export type InboxTarget = {
  hostId: string;
  runId: string;
  stepId: string;
  reviewId: string | null;
};

type Props = {
  run: PipelineRun;
  steps: PipelineStepRecord[];
  index: number;
  api: Pick<PipelinesApi, 'readEvidence'>;
  onClose: () => void;
  onInbox: (target: InboxTarget) => void;
  onSession: (key: string) => void;
};

const evidenceIcons: Record<Evidence['kind'], LucideIcon> = {
  log: ScrollText,
  text: FileText,
  file: FileText,
  screenshot: FileText,
  link: Link,
  steps: ScrollText,
};

const SECOND_MS = 1000;

const stateNotes: Partial<Record<PipelineStepRecord['state'], string>> = {
  pending: 'This step has not started.',
  'awaiting-human': 'Waiting for your decision in the Inbox.',
  interrupted: 'The step stopped before it reported a result.',
  uncertain:
    'The external action may have run. Check its effect before you resume the pipeline.',
  skipped: 'This step was skipped.',
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; evidence: PipelineEvidence };

function EvidencePreview({ state }: { state: PreviewState }) {
  if (state.status === 'loading')
    return (
      <p role="status" className="px-2 py-2 text-2xs text-muted-foreground">
        Loading preview…
      </p>
    );
  if (state.status === 'error')
    return (
      <p
        role="alert"
        className="px-2 py-2 text-2xs text-destructive [overflow-wrap:anywhere]"
      >
        {state.message}
      </p>
    );
  const { evidence } = state;
  if (evidence.status !== 'text' || evidence.text === null)
    return (
      <p className="px-2 py-2 text-2xs text-muted-foreground">
        {evidence.status === 'too-large'
          ? 'This file is too large to preview.'
          : evidence.status === 'binary'
            ? 'This file is not text.'
            : 'The file is no longer available.'}
      </p>
    );
  return (
    <pre
      aria-label="Evidence preview"
      className="max-h-80 overflow-auto rounded-md border bg-code-background p-2.5 font-mono text-2xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {evidence.text}
    </pre>
  );
}

function StepResult({
  run,
  steps,
  index,
  api,
  onInbox,
  onSession,
}: Omit<Props, 'onClose'>) {
  const now = useNow(SECOND_MS);
  const view = pipelineSteps(run, steps)[index];
  const attempts = steps
    .filter(record => record.index === index && record.attempt > 0)
    .sort((a, b) => a.attempt - b.attempt);
  const [attempt, setAttempt] = useState<number | null>(null);
  const record =
    attempts.find(item => item.attempt === attempt) ??
    attempts.at(-1) ??
    view?.record ??
    null;
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const requests = useRef(0);
  useEffect(() => {
    requests.current += 1;
  }, [record?.id]);
  if (!view) return null;
  const { definition } = view;
  const result = record?.result ?? null;
  const state = record?.state ?? 'pending';
  const maxAttempts = definition.retries + 1;
  const duration = result
    ? formatDuration(result.durationMs)
    : state === 'running' && record?.startedAt
      ? formatDuration(now - Date.parse(record.startedAt))
      : '';
  const preview = async (item: Evidence, key: string) => {
    if (!record || !item.path) return;
    if (previews[key] && previews[key].status !== 'error') {
      setPreviews(previous =>
        Object.fromEntries(
          Object.entries(previous).filter(([entry]) => entry !== key),
        ),
      );
      return;
    }
    const request = requests.current;
    setPreviews(previous => ({ ...previous, [key]: { status: 'loading' } }));
    try {
      const evidence = await api.readEvidence(run.hostId, {
        runId: run.id,
        stepId: record.id,
        path: item.path,
      });
      if (request === requests.current)
        setPreviews(previous => ({
          ...previous,
          [key]: { status: 'loaded', evidence },
        }));
    } catch (failure) {
      if (request === requests.current)
        setPreviews(previous => ({
          ...previous,
          [key]: {
            status: 'error',
            message: `Could not read the evidence. ${errorDetail(failure)}`,
          },
        }));
    }
  };
  const outputs = Object.entries(result?.outputs ?? {});
  const evidence = result?.evidence ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 text-xs">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 font-medium',
              toneText[stepStateTones[state]],
            )}
          >
            <StepStateIcon state={state} />
            {stepStateLabels[state]}
          </span>
          {duration && (
            <span className="text-muted-foreground tabular-nums">
              {duration}
            </span>
          )}
          {record && record.attempt > 0 && (
            <span className="text-muted-foreground">
              Attempt {record.attempt} of {maxAttempts}
            </span>
          )}
        </div>
        <p className="text-2xs text-muted-foreground">
          {[
            definition.type[0]!.toUpperCase() + definition.type.slice(1),
            phaseLabels[definition.phase],
            definition.skill ? `Skill ${definition.skill}` : '',
            definition.on_fail === 'fix' ? 'Sends failures back for a fix' : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      {attempts.length > 1 && (
        <div
          role="radiogroup"
          aria-label="Attempt"
          className="flex w-fit gap-0.5 rounded-lg bg-segment-track p-0.5"
        >
          {attempts.map(item => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={item.id === record?.id}
              aria-label={`Attempt ${item.attempt} · ${stepStateLabels[item.state]}`}
              onClick={() => setAttempt(item.attempt)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-checked:bg-segment-active aria-checked:text-foreground"
            >
              <StepStateIcon state={item.state} className="size-3" />
              {item.attempt}
            </button>
          ))}
        </div>
      )}
      {run.attention && run.currentStepIndex === index && (
        <p className="rounded-md border px-2.5 py-2 text-warning-foreground [overflow-wrap:anywhere]">
          {run.attention}
        </p>
      )}
      {result ? (
        <p className="leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {result.summary || 'No summary was reported.'}
        </p>
      ) : (
        <p className="leading-5 text-muted-foreground">
          {state === 'running'
            ? 'Running. The result appears here when the step finishes.'
            : (stateNotes[state] ?? 'No result was reported.')}
        </p>
      )}
      {(definition.type === 'human' || record?.reviewId) && record && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() =>
            onInbox({
              hostId: run.hostId,
              runId: run.id,
              stepId: record.id,
              reviewId: record.reviewId,
            })
          }
        >
          <Inbox />
          Open in Inbox
        </Button>
      )}
      {record?.sessionId && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onSession(hostKey(record.sessionId!, run.hostId))}
        >
          <MessageSquare />
          Open step session
        </Button>
      )}
      {outputs.length > 0 && (
        <section aria-label="Outputs" className="space-y-1.5">
          <h3 className="text-2xs font-medium text-muted-foreground">
            Outputs
          </h3>
          <table className="w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-md border">
            <tbody>
              {outputs.map(([key, value]) => (
                <tr key={key} className="[&:not(:last-child)>td]:border-b">
                  <td className="w-28 px-2 py-1.5 align-top font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                    {key}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-2xs select-text [overflow-wrap:anywhere]">
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {evidence.length > 0 && (
        <section aria-label="Evidence" className="space-y-1.5">
          <h3 className="text-2xs font-medium text-muted-foreground">
            Evidence
          </h3>
          <ul className="space-y-1">
            {evidence.map((item, position) => {
              const Icon = evidenceIcons[item.kind];
              const key = `${record?.id}:${position}`;
              const previewable =
                (item.kind === 'log' || item.kind === 'text') && !!item.path;
              return (
                <li key={key} className="space-y-1">
                  <div className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1">
                    <Icon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={item.label}
                    >
                      {item.label}
                    </span>
                    {previewable && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-6 px-2 text-2xs"
                        aria-expanded={!!previews[key]}
                        onClick={() => void preview(item, key)}
                      >
                        {previews[key] ? 'Hide' : 'Preview'}
                      </Button>
                    )}
                  </div>
                  {item.url && (
                    <p className="flex items-center gap-1.5 pl-6 font-mono text-2xs text-muted-foreground select-text [overflow-wrap:anywhere]">
                      <ExternalLink
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                      {item.url}
                    </p>
                  )}
                  {item.text && (
                    <p className="pl-6 text-2xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                      {item.text}
                    </p>
                  )}
                  {item.path && !previewable && (
                    <p className="pl-6 font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                      {item.path}
                    </p>
                  )}
                  {previews[key] && <EvidencePreview state={previews[key]} />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {result?.cost.usd != null && (
        <p className="text-2xs text-muted-foreground">
          {[
            result.cost.provider,
            `$${result.cost.usd.toFixed(2)}`,
            result.cost.inputTokens != null
              ? `${result.cost.inputTokens.toLocaleString('en-US')} input tokens`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

export default function PipelineStepResult({ onClose, ...props }: Props) {
  const definition = props.run.pipeline.steps[props.index];
  return (
    <section
      aria-label="Step result"
      data-run-id={props.run.id}
      data-step-index={props.index}
      className={cn(
        panelSurface,
        'min-[1200px]:w-[380px] min-[1600px]:w-[440px]',
      )}
    >
      <PanelHeader
        icon={Workflow}
        title={definition?.name ?? 'Step'}
        meta={props.run.specTitle}
      >
        <PanelAction aria-label="Close step result" onClick={onClose}>
          <X className="size-4" />
        </PanelAction>
      </PanelHeader>
      <StepResult key={`${props.run.id}:${props.index}`} {...props} />
    </section>
  );
}
