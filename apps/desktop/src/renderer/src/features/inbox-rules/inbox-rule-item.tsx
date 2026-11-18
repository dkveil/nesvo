import { useState } from 'react';
import { inboxRuleLimits, type PullRequestReference } from '@nesvo/contracts';
import ReactMarkdown from 'react-markdown';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { Input } from '@/shared/ui/input';
import { StatusMessage } from '@/shared/ui/status-message';
import type { HostedInboxItem, InboxItemDecision } from './use-inbox-items';

type SummaryProps = {
  item: HostedInboxItem;
  onOpenChanges?: () => void;
  onOpenPullRequest?: (reference: PullRequestReference) => void;
};

export function InboxRuleSummary({
  item,
  onOpenChanges,
  onOpenPullRequest,
}: SummaryProps) {
  const { presentation } = item;
  const diff = presentation.diff;
  if (item.binding === 'external')
    return (
      <div className="min-w-0 space-y-2">
        <Badge appearance="outline" className="max-w-full">
          <span className="truncate">{item.source}</span>
        </Badge>
        <div className="max-h-48 space-y-1.5 overflow-y-auto text-ui [overflow-wrap:anywhere] [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_pre]:whitespace-pre-wrap">
          <ReactMarkdown
            skipHtml
            allowedElements={[
              'p',
              'strong',
              'em',
              'ol',
              'ul',
              'li',
              'pre',
              'code',
              'blockquote',
              'br',
            ]}
            unwrapDisallowed
          >
            {presentation.text}
          </ReactMarkdown>
        </div>
        {item.note && (
          <p className="text-2xs text-muted-foreground">{item.note}</p>
        )}
      </div>
    );
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-ui [overflow-wrap:anywhere] whitespace-pre-wrap">
        {presentation.text || item.subject}
      </p>
      {presentation.command && (
        <CodeBlock
          code={presentation.command}
          label="Command"
          wrap
          maxHeightClassName="max-h-32"
        />
      )}
      {presentation.show.includes('diff') && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
          <span>
            {diff
              ? diff.error
                ? diff.error
                : `${diff.files.length}${diff.truncated ? '+' : ''} changed ${diff.files.length === 1 ? 'file' : 'files'} (${diff.scope === 'branch' ? 'branch' : 'uncommitted'})`
              : 'Reading the diff…'}
          </span>
          {onOpenChanges && (
            <Button variant="link" size="inline" onClick={onOpenChanges}>
              Open changes
            </Button>
          )}
        </div>
      )}
      {diff && diff.files.length > 0 && (
        <NativeDisclosure
          title={
            <span className="text-2xs text-muted-foreground">
              Changed files
            </span>
          }
          triggerLabel="Show the changed files"
          className="-ml-2"
        >
          <ul className="max-h-40 space-y-0.5 overflow-y-auto text-2xs [overflow-wrap:anywhere]">
            {diff.files.map(file => (
              <li key={file.path}>
                {file.path}
                {file.additions !== null && (
                  <span className="text-muted-foreground">
                    {' '}
                    +{file.additions} −{file.deletions ?? 0}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </NativeDisclosure>
      )}
      {presentation.pullRequest && onOpenPullRequest && (
        <Button
          variant="link"
          size="inline"
          onClick={() => onOpenPullRequest(presentation.pullRequest!)}
        >
          Review pull request #{presentation.pullRequest.number}
        </Button>
      )}
      {presentation.plan && (
        <NativeDisclosure
          title={<span className="text-2xs text-muted-foreground">Plan</span>}
          triggerLabel="Show the plan"
          className="-ml-2"
        >
          <p className="max-h-60 overflow-y-auto text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
            {presentation.plan}
          </p>
        </NativeDisclosure>
      )}
      {presentation.report && (
        <p className="text-2xs text-muted-foreground [overflow-wrap:anywhere]">
          Report {presentation.report.status} · {presentation.report.summary}
        </p>
      )}
      {item.outcome && (
        <p className="text-2xs text-muted-foreground [overflow-wrap:anywhere]">
          {item.outcome}
        </p>
      )}
    </div>
  );
}

type DecisionsProps = {
  item: HostedInboxItem;
  enabled: boolean;
  deciding: boolean;
  error?: string;
  via?: InboxItemDecision['via'];
  onDecide: (decision: InboxItemDecision) => void;
};

export function InboxRuleDecisions({
  item,
  enabled,
  deciding,
  error,
  via = 'desktop',
  onDecide,
}: DecisionsProps) {
  const [note, setNote] = useState('');
  if (item.status !== 'pending') return null;
  const external = item.binding === 'external';
  const disabled = !enabled || deciding;
  const withNote = note.trim() ? { note: note.trim() } : {};
  return (
    <div className="col-start-2 row-start-1 flex max-w-72 flex-col items-end gap-1.5 self-center">
      {(item.action === 'hold' || external) && (
        <Input
          aria-label={
            external ? 'Operator comment' : `Note for ${item.rule?.name}`
          }
          placeholder={
            external ? 'Comment (optional)' : 'Note for the agent (optional)'
          }
          maxLength={inboxRuleLimits.note}
          value={note}
          disabled={disabled}
          onChange={event => setNote(event.target.value)}
        />
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        {item.action === 'hold' && (
          <>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                onDecide({ decision: 'approve', via, ...withNote })
              }
            >
              Approve
            </Button>
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                onDecide({ decision: 'decline', via, ...withNote })
              }
            >
              Decline
            </Button>
          </>
        )}
        {item.action === 'ask' &&
          item.options.map(option => (
            <Button
              key={option}
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                onDecide({
                  decision: 'answer',
                  option,
                  via,
                  ...(external ? withNote : {}),
                })
              }
            >
              {option}
            </Button>
          ))}
        {item.action !== 'hold' && !external && (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => onDecide({ decision: 'dismiss', via })}
          >
            Dismiss
          </Button>
        )}
      </div>
      {deciding && (
        <StatusMessage tone="loading">Sending decision…</StatusMessage>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </div>
  );
}
