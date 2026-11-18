import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import type {
  SharedWorkflowLink,
  WorkflowSharePrepared,
  WorkflowSharingApi,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import { formatExpiry } from '@/shared/lib/format-expiry';

const COPIED_FEEDBACK_MS = 1500;

export type ShareTarget = {
  hostId: string;
  directory: string;
  workflowName: string;
};

type Props = {
  target: ShareTarget | null;
  onOpenChange: (open: boolean) => void;
  api: Pick<WorkflowSharingApi, 'prepare' | 'upload'>;
};

type ShareState =
  | { status: 'scanning' }
  | { status: 'error'; message: string }
  | { status: 'prepared'; prepared: WorkflowSharePrepared }
  | { status: 'uploading'; prepared: WorkflowSharePrepared }
  | {
      status: 'upload-failed';
      prepared: WorkflowSharePrepared;
      message: string;
    }
  | { status: 'shared'; link: SharedWorkflowLink };

const typeLabel = (type: string) => type[0]!.toUpperCase() + type.slice(1);

const kilobytes = (bytes: number) =>
  `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;

const siteName = (origin: string) => origin.replace(/^https?:\/\//, '');

function Findings({ prepared }: { prepared: WorkflowSharePrepared }) {
  const { findings, findingCount } = prepared.draft;
  return (
    <section aria-label="Possible secrets" className="space-y-2">
      <InlineNotice tone="error">
        {findingCount === 1
          ? 'One line looks like a secret.'
          : `${findingCount} lines look like secrets.`}{' '}
        Remove each value from its file, for example by naming the variable in{' '}
        <code className="font-mono">needs</code>, then scan again. Nothing is
        uploaded until the files are clean.
      </InlineNotice>
      <ul className="space-y-px rounded-surface border p-1">
        {findings.map((finding, index) => (
          <li
            key={`${finding.fileName}:${finding.line}:${index}`}
            className="space-y-0.5 px-2 py-1.5 text-xs"
          >
            <p className="flex min-w-0 items-center gap-2">
              <span className="font-medium">{finding.label}</span>
              <span className="truncate font-mono text-2xs text-muted-foreground">
                {finding.fileName}:{finding.line}
              </span>
            </p>
            <p className="font-mono text-2xs break-all text-muted-foreground">
              {finding.excerpt}
            </p>
          </li>
        ))}
      </ul>
      {findingCount > findings.length && (
        <p className="text-2xs text-muted-foreground">
          {findingCount - findings.length} more not shown.
        </p>
      )}
    </section>
  );
}

function UploadPreview({ prepared }: { prepared: WorkflowSharePrepared }) {
  const { draft } = prepared;
  return (
    <section aria-label="Files to upload" className="space-y-2">
      <SectionLabel count={draft.steps.length + 1}>
        Uploaded to {siteName(prepared.origin)} · {kilobytes(prepared.bytes)}
      </SectionLabel>
      <CodeBlock
        label={`workflows/${draft.workflow.fileName}`}
        code={draft.workflow.content}
        wrap
        maxHeightClassName="max-h-48"
      />
      {draft.steps.map(step => (
        <CodeBlock
          key={step.fileName}
          label={`steps/${step.fileName} · ${typeLabel(step.type)}`}
          code={step.content}
          wrap
          maxHeightClassName="max-h-48"
        />
      ))}
    </section>
  );
}

function SharedLink({ link }: { link: SharedWorkflowLink }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    void navigator.clipboard.writeText(link.url).then(() => {
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => setCopied(false),
        COPIED_FEEDBACK_MS,
      );
    });
  };
  return (
    <div className="space-y-2">
      <Field id="shared-workflow-link" label="Link">
        <div className="flex items-center gap-2">
          <Input
            id="shared-workflow-link"
            size="md"
            readOnly
            value={link.url}
            className="font-mono"
            onFocus={event => event.currentTarget.select()}
          />
          <Button variant="outline" size="md" onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Field>
      <StatusMessage tone="success">
        {formatExpiry(link.expiresAt)}. Revoke it earlier in Settings › Sharing.
      </StatusMessage>
    </div>
  );
}

export function ShareWorkflowDialog({ target, onOpenChange, api }: Props) {
  const [state, setState] = useState<ShareState>({ status: 'scanning' });
  const request = useRef(0);
  const scan = (current: ShareTarget) => {
    const id = ++request.current;
    setState({ status: 'scanning' });
    api
      .prepare(current.hostId, {
        directory: current.directory,
        name: current.workflowName,
      })
      .then(
        prepared => {
          if (id === request.current)
            setState({ status: 'prepared', prepared });
        },
        failure => {
          if (id === request.current)
            setState({
              status: 'error',
              message: `The workflow could not be prepared. ${errorDetail(failure)}`,
            });
        },
      );
  };
  const opened = useRef<ShareTarget | null>(null);
  useEffect(() => {
    if (!target || opened.current === target) return;
    opened.current = target;
    scan(target);
  });
  const upload = (prepared: WorkflowSharePrepared) => {
    setState({ status: 'uploading', prepared });
    api.upload(prepared.draftId).then(
      link => setState({ status: 'shared', link }),
      failure =>
        setState({
          status: 'upload-failed',
          prepared,
          message: errorDetail(failure),
        }),
    );
  };
  const prepared =
    state.status === 'prepared' ||
    state.status === 'uploading' ||
    state.status === 'upload-failed'
      ? state.prepared
      : null;
  const blocked =
    !!prepared && (prepared.draft.findingCount > 0 || !!prepared.sizeIssue);
  return (
    <Dialog
      open={!!target}
      onOpenChange={open => {
        if (!open && state.status === 'uploading') return;
        if (!open) opened.current = null;
        onOpenChange(open);
      }}
    >
      <DialogContent
        surface="panel"
        showCloseButton={state.status !== 'uploading'}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Share {target?.workflowName ?? 'workflow'}</DialogTitle>
          <DialogDescription>
            Anyone with the link can read and import this workflow for 7 days,
            without an account. Review exactly what is uploaded below.
          </DialogDescription>
        </DialogHeader>
        {state.status === 'scanning' && (
          <StatusMessage tone="loading">
            Reading the workflow files and checking them for secrets…
          </StatusMessage>
        )}
        {state.status === 'error' && (
          <StatusMessage tone="error">{state.message}</StatusMessage>
        )}
        {prepared && prepared.draft.findingCount > 0 && (
          <Findings prepared={prepared} />
        )}
        {prepared?.sizeIssue && (
          <InlineNotice tone="error">{prepared.sizeIssue}</InlineNotice>
        )}
        {prepared && !blocked && <UploadPreview prepared={prepared} />}
        {state.status === 'upload-failed' && (
          <StatusMessage tone="error">
            The link was not created. {state.message}
          </StatusMessage>
        )}
        {state.status === 'shared' && <SharedLink link={state.link} />}
        <DialogFooter>
          {state.status === 'shared' ? (
            <Button size="lg" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <DialogCancel
                disabled={state.status === 'uploading'}
                onClick={() => onOpenChange(false)}
              />
              {(blocked || state.status === 'error') && target && (
                <Button variant="ghost" size="lg" onClick={() => scan(target)}>
                  <RefreshCw />
                  Scan again
                </Button>
              )}
              {!blocked && (
                <Button
                  size="lg"
                  disabled={!prepared || state.status === 'uploading'}
                  onClick={() => prepared && upload(prepared)}
                >
                  {state.status === 'uploading'
                    ? 'Uploading…'
                    : 'Upload and create link'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
