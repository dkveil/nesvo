import { useEffect, useRef, useState } from 'react';
import type { WorkflowsApi } from '@nesvo/contracts';
import {
  ExternalLink,
  FileText,
  Inbox,
  Link,
  MessageSquare,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { errorDetail } from '@/entities/session';
import {
  formatDuration,
  phaseLabels,
  workflowSteps,
  stepStateLabels,
  stepStateTones,
  toneText,
  type Evidence,
  type WorkflowEvidence,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '@/entities/workflow';
import { StepStateIcon } from '@/entities/workflow/step-state-icon';
import { stepTypeLabels } from '@/entities/workflow-graph';
import { hostKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { SectionLabel } from '@/shared/ui/section-label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { ChildQueue } from './child-queue';
import { CheckObservation } from './check-observation';

export type InboxTarget = {
  hostId: string;
  runId: string;
  stepId: string;
  reviewId: string | null;
};

type Props = {
  run: WorkflowRun;
  steps: WorkflowStepRecord[];
  index: number;
  api: Pick<WorkflowsApi, 'readEvidence'>;
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

const stateNotes: Partial<Record<WorkflowStepRecord['state'], string>> = {
  pending: 'This step has not started.',
  'awaiting-human': 'Waiting for your decision in the Inbox.',
  interrupted: 'The step stopped before it reported a result.',
  uncertain:
    'The external action may have run. Check its effect before you resume the workflow.',
  skipped: 'This step was skipped.',
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; evidence: WorkflowEvidence };

function EvidencePreview({ state }: { state: PreviewState }) {
  if (state.status === 'loading')
    return (
      <StatusMessage tone="loading" className="px-1 py-1">
        Loading preview…
      </StatusMessage>
    );
  if (state.status === 'error')
    return (
      <StatusMessage tone="error" className="px-1 py-1">
        {state.message}
      </StatusMessage>
    );
  const { evidence } = state;
  if (evidence.status !== 'text' || evidence.text === null)
    return (
      <p className="px-1 py-1 text-2xs text-muted-foreground">
        {evidence.status === 'too-large'
          ? 'This file is too large to preview.'
          : evidence.status === 'binary'
            ? 'This file is not text.'
            : 'The file is no longer available.'}
      </p>
    );
  return <CodeBlock aria-label="Evidence preview" code={evidence.text} wrap />;
}

export function StepResult({
  run,
  steps,
  index,
  api,
  onInbox,
  onSession,
}: Props) {
  const now = useNow(SECOND_MS);
  const view = workflowSteps(run, steps)[index];
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
        setPreviews(previous =>
          previous[key]
            ? { ...previous, [key]: { status: 'loaded', evidence } }
            : previous,
        );
    } catch (failure) {
      if (request === requests.current)
        setPreviews(previous =>
          previous[key]
            ? {
                ...previous,
                [key]: {
                  status: 'error',
                  message: `Could not read the evidence. ${errorDetail(failure)}`,
                },
              }
            : previous,
        );
    }
  };
  const children = result?.items ?? record?.children;
  const outputs = Object.entries(result?.outputs ?? {}).filter(
    ([key]) => !children || key !== 'items',
  );
  const evidence = result?.evidence ?? [];
  return (
    <div className="space-y-4 text-xs">
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
          {record?.iteration && (
            <span className="text-muted-foreground">
              Iteration {record.iteration}
            </span>
          )}
          {record && record.attempt > 0 && (
            <span className="text-muted-foreground">
              Attempt {record.attempt}
            </span>
          )}
        </div>
        <p className="text-2xs text-muted-foreground">
          {[
            stepTypeLabels[definition.type],
            phaseLabels[definition.phase],
            definition.skill ? `Skill ${definition.skill}` : '',
            definition.on_fail === 'fix'
              ? definition.type === 'check'
                ? 'Needs attention on failure'
                : 'Sends failures back for a fix'
              : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      {attempts.length > 1 && (
        <Select
          value={String(record?.attempt ?? '')}
          onValueChange={value => setAttempt(Number(value))}
        >
          <SelectTrigger aria-label="Attempt history" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {attempts.map(item => (
              <SelectItem key={item.id} value={String(item.attempt)}>
                {item.iteration ? `Iteration ${item.iteration} · ` : ''}
                Attempt {item.attempt} · {stepStateLabels[item.state]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {record?.skip ? (
        <p className="leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          Skipped: {record.skip.reason}
        </p>
      ) : result?.check ? (
        <>
          {(!result.check.invocations.length ||
            result.summary.startsWith('Timed out')) && (
            <p className="leading-5">{result.summary}</p>
          )}
          <CheckObservation
            check={result.check}
            profile={run.projectProfile}
            hostId={run.hostId}
          />
        </>
      ) : result ? (
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
      {children && (
        <ChildQueue
          items={children}
          hostId={run.hostId}
          onSession={onSession}
        />
      )}
      {record?.sessionId && !children && (
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
        <section aria-label="Outputs" className="space-y-1">
          <SectionLabel className="px-0">Outputs</SectionLabel>
          <KeyValueList
            className="font-mono text-2xs"
            entries={outputs.map(([key, value]) => ({
              key,
              label: key,
              value: <span className="select-text">{value}</span>,
            }))}
          />
        </section>
      )}
      {evidence.length > 0 && (
        <section aria-label="Evidence" className="space-y-1">
          <SectionLabel className="px-0">Evidence</SectionLabel>
          <ul className="space-y-1">
            {evidence.map((item, position) => {
              const Icon = evidenceIcons[item.kind];
              const key = `${record?.id}:${position}`;
              const previewable =
                (item.kind === 'log' || item.kind === 'text') && !!item.path;
              return (
                <li key={key} className="space-y-1">
                  <div className="flex h-7 min-w-0 items-center gap-2">
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
                    {item.rule && (
                      <span className="font-mono text-2xs text-muted-foreground">
                        {item.rule}
                      </span>
                    )}
                    {previewable && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
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
