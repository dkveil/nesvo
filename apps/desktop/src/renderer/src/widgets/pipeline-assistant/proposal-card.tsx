import { useEffect, useState } from 'react';
import type {
  DefinitionCatalog,
  DefinitionIssue,
  PipelineAssistantChange,
  PipelineAssistantDocument,
  PipelineDefinitionConflict,
} from '@nesvo/contracts';
import { Check, CircleX, RefreshCw, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import {
  fromCatalog,
  stepDefinitionOf,
  stepFileText,
  toFileText,
} from '@/entities/pipeline-graph';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ProposalDiff } from './proposal-diff';

export type ProposalDecision = 'applied' | 'discarded';

type Props = {
  hostId: string;
  directory: string;
  sessionId: string;
  sessionDirectory: string | null;
  change: PipelineAssistantChange;
  issues: DefinitionIssue[];
  document: PipelineAssistantDocument | null;
  decision: ProposalDecision | null;
  connected: boolean;
  onDecision: (decision: ProposalDecision) => void;
  onApplied: () => void;
};

type Base =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      text: string;
      hash: string | null;
      source: 'new' | 'file' | 'editor' | 'catalog';
    };

type Outcome =
  | { status: 'idle' }
  | { status: 'applying' }
  | { status: 'conflict'; conflict: PipelineDefinitionConflict }
  | { status: 'refused'; issues: DefinitionIssue[] }
  | { status: 'error'; message: string };

const kindLabels = { step: 'Step', pipeline: 'Pipeline' } as const;
const scopeLabels = { project: 'Project', global: 'Global' } as const;

const normalizedPath = (value: string) =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

function relativePath(root: string, path: string) {
  const base = normalizedPath(root);
  const target = normalizedPath(path);
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

async function readCurrentText(
  hostId: string,
  sessionId: string,
  sessionDirectory: string | null,
  path: string,
) {
  const relative = sessionDirectory
    ? relativePath(sessionDirectory, path)
    : null;
  if (!relative) return null;
  try {
    const file = await window.nesvo.readWorkspaceFile(
      { sessionId, path: relative },
      hostId,
    );
    return file.status === 'text' && !file.truncated ? file.text : null;
  } catch {
    return null;
  }
}

const catalogReads = new Map<string, Promise<DefinitionCatalog>>();
const catalogReadAttempts = 4;
const catalogRetryDelayMs = 400;

const pause = (milliseconds: number) =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function readCatalogWithRetry(hostId: string, directory: string) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await window.nesvo.pipelines.listDefinitions(hostId, {
        directory,
      });
    } catch (failure) {
      if (attempt >= catalogReadAttempts) throw failure;
      await pause(catalogRetryDelayMs * attempt);
    }
  }
}

function readCatalog(hostId: string, directory: string) {
  const key = JSON.stringify([hostId, directory]);
  const pending = catalogReads.get(key);
  if (pending) return pending;
  const request = readCatalogWithRetry(hostId, directory).finally(() =>
    catalogReads.delete(key),
  );
  catalogReads.set(key, request);
  return request;
}

type OpenText = { text: string; hash: string } | null;

async function loadBase(
  hostId: string,
  directory: string,
  sessionId: string,
  sessionDirectory: string | null,
  change: PipelineAssistantChange,
  open: OpenText,
): Promise<Base> {
  const catalog = await readCatalog(hostId, directory);
  const entries = change.kind === 'step' ? catalog.steps : catalog.pipelines;
  const entry = entries.find(
    item => item.name === change.name && item.source.scope === change.scope,
  );
  if (!entry) return { status: 'ready', text: '', hash: null, source: 'new' };
  const hash = entry.source.contentHash;
  const text = await readCurrentText(
    hostId,
    sessionId,
    sessionDirectory,
    entry.source.path,
  );
  if (text !== null) return { status: 'ready', text, hash, source: 'file' };
  if (open && open.hash === hash)
    return { status: 'ready', text: open.text, hash, source: 'editor' };
  const pipeline =
    change.kind === 'pipeline'
      ? catalog.pipelines.find(
          item =>
            item.name === change.name && item.source.scope === change.scope,
        )
      : undefined;
  const step =
    change.kind === 'step'
      ? catalog.steps.find(
          item =>
            item.name === change.name && item.source.scope === change.scope,
        )
      : undefined;
  return {
    status: 'ready',
    text: pipeline
      ? toFileText(fromCatalog(pipeline, catalog))
      : step
        ? stepFileText(stepDefinitionOf(step))
        : '',
    hash,
    source: 'catalog',
  };
}

function IssueList({ issues }: { issues: DefinitionIssue[] }) {
  return (
    <ul className="space-y-1">
      {issues.map((issue, index) => {
        const error = issue.severity === 'error';
        const Icon = error ? CircleX : TriangleAlert;
        return (
          <li
            key={index}
            className="flex min-w-0 items-start gap-1.5 text-2xs leading-4"
          >
            <Icon
              role="img"
              aria-label={error ? 'Error' : 'Warning'}
              className={cn(
                'mt-px size-3 shrink-0',
                error ? 'text-error-foreground' : 'text-warning-foreground',
              )}
            />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {issue.message}
              {issue.line ? ` · line ${issue.line}` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function baseLabel(change: PipelineAssistantChange, base: Base) {
  if (base.status !== 'ready') return '';
  if (base.hash === null)
    return change.basedOnHash
      ? 'The file no longer exists. Applying creates it.'
      : 'New file';
  if (base.source === 'catalog')
    return 'The file could not be read. The diff compares with its definition from the catalog; formatting may differ.';
  if (change.basedOnHash && change.basedOnHash !== base.hash)
    return 'The file changed since the assistant read it. The diff compares with the current file.';
  return 'Changes the current file';
}

export function ProposalCard({
  hostId,
  directory,
  sessionId,
  sessionDirectory,
  change,
  issues,
  document,
  decision,
  connected,
  onDecision,
  onApplied,
}: Props) {
  const [base, setBase] = useState<Base>({ status: 'loading' });
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const openMatches =
    !!document &&
    document.kind === change.kind &&
    document.scope === change.scope &&
    document.name === change.name;
  const openText = openMatches ? document.text : null;
  const openHash = openMatches ? document.contentHash : null;
  useEffect(() => {
    if (decision) return;
    let active = true;
    loadBase(
      hostId,
      directory,
      sessionId,
      sessionDirectory,
      change,
      openText !== null && openHash !== null
        ? { text: openText, hash: openHash }
        : null,
    ).then(
      next => {
        if (active) setBase(next);
      },
      failure => {
        if (active)
          setBase({
            status: 'error',
            message: `Could not read the current definitions. ${errorDetail(failure)}`,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [
    attempt,
    decision,
    hostId,
    directory,
    sessionId,
    sessionDirectory,
    change,
    openText,
    openHash,
  ]);
  const errors = issues.filter(issue => issue.severity === 'error');
  const unchanged = base.status === 'ready' && base.text === change.document;
  const apply = async () => {
    if (base.status !== 'ready') return;
    setOutcome({ status: 'applying' });
    try {
      const result = await window.nesvo.pipelines.saveDefinition(hostId, {
        directory,
        scope: change.scope,
        kind: change.kind,
        name: change.name,
        document: change.document,
        expectedHash: base.hash,
      });
      if ('type' in result) {
        setOutcome(
          result.type === 'pipeline-definition-conflict'
            ? { status: 'conflict', conflict: result }
            : { status: 'refused', issues: result.issues },
        );
        return;
      }
      setOutcome({ status: 'idle' });
      onDecision('applied');
      onApplied();
    } catch (failure) {
      setOutcome({
        status: 'error',
        message: `Could not apply the change. ${errorDetail(failure)}`,
      });
    }
  };
  const reload = () => {
    if (outcome.status !== 'conflict') return;
    const { conflict } = outcome;
    setOutcome({ status: 'idle' });
    if (conflict.currentHash === null)
      setBase({ status: 'ready', text: '', hash: null, source: 'new' });
    else if (conflict.document !== null)
      setBase({
        status: 'ready',
        text: conflict.document,
        hash: conflict.currentHash,
        source: 'file',
      });
    else {
      setBase({ status: 'loading' });
      setAttempt(value => value + 1);
    }
  };
  const label = baseLabel(change, base);
  return (
    <article
      aria-label={`${kindLabels[change.kind]} ${change.name}`}
      data-proposal-change={change.name}
      data-proposal-state={decision ?? 'open'}
      className="min-w-0 space-y-2 rounded-lg border bg-card/60 p-2.5"
    >
      <header className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 rounded border px-1.5 text-2xs leading-4 text-muted-foreground">
          {kindLabels[change.kind]}
        </span>
        <span className="shrink-0 rounded border px-1.5 text-2xs leading-4 text-muted-foreground">
          {scopeLabels[change.scope]}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs font-medium"
          title={change.name}
        >
          {change.name}
        </span>
        {decision === 'applied' && (
          <span className="flex shrink-0 items-center gap-1 text-2xs text-success-foreground">
            <Check className="size-3" aria-hidden="true" />
            Applied
          </span>
        )}
        {decision === 'discarded' && (
          <span className="shrink-0 text-2xs text-muted-foreground">
            Discarded
          </span>
        )}
      </header>
      {change.summary && (
        <p className="text-xs leading-5 [overflow-wrap:anywhere]">
          {change.summary}
        </p>
      )}
      {!decision && (
        <>
          {base.status === 'loading' && (
            <p role="status" className="text-2xs text-muted-foreground">
              Reading the current file…
            </p>
          )}
          {base.status === 'error' && (
            <div className="flex items-center gap-2">
              <p
                role="alert"
                className="min-w-0 flex-1 text-2xs text-destructive [overflow-wrap:anywhere]"
              >
                {base.message}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setBase({ status: 'loading' });
                  setAttempt(value => value + 1);
                }}
              >
                <RefreshCw />
                Retry
              </Button>
            </div>
          )}
          {base.status === 'ready' && (
            <>
              <p className="text-2xs text-muted-foreground">{label}</p>
              {unchanged ? (
                <p className="text-2xs text-muted-foreground">
                  The proposed text matches the current file.
                </p>
              ) : (
                <ProposalDiff
                  name={`${change.name}.md`}
                  before={base.text}
                  after={change.document}
                />
              )}
            </>
          )}
          {issues.length > 0 && <IssueList issues={issues} />}
          {errors.length > 0 && (
            <p className="text-2xs text-muted-foreground">
              Errors block Apply. Ask the assistant to fix them.
            </p>
          )}
          {outcome.status === 'conflict' && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-warning-foreground/40 px-2 py-1.5"
            >
              <p className="min-w-0 flex-1 text-2xs leading-4">
                The file changed since the assistant read it. Reload to compare
                with the current file.
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={reload}
              >
                <RefreshCw />
                Reload
              </Button>
            </div>
          )}
          {outcome.status === 'refused' && (
            <div role="alert" className="space-y-1">
              <p className="text-2xs text-destructive">
                The change was refused.
              </p>
              <IssueList issues={outcome.issues} />
            </div>
          )}
          {outcome.status === 'error' && (
            <p
              role="alert"
              className="text-2xs text-destructive [overflow-wrap:anywhere]"
            >
              {outcome.message}
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={outcome.status === 'applying'}
              onClick={() => onDecision('discarded')}
            >
              Discard
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={
                !connected ||
                base.status !== 'ready' ||
                errors.length > 0 ||
                unchanged ||
                outcome.status === 'applying' ||
                outcome.status === 'conflict'
              }
              onClick={() => void apply()}
            >
              {outcome.status === 'applying' ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        </>
      )}
    </article>
  );
}
