import { Button } from '@/shared/ui/button';
import { errorDetail } from '@/entities/session';
import { CodeBlock } from '@/shared/ui/code-block';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { InlineNotice } from '@/shared/ui/inline-notice';
import type { McpRepositoryLaunch, McpServerList } from '@nesvo/contracts';
import { useRef, useState } from 'react';
import type { McpConfiguration } from './use-mcp-configuration';

function ReviewField({
  label,
  value,
  full,
}: McpRepositoryLaunch['fields'][number] & { full?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const limit = 104;
  const characters = Array.from(value);
  const hidden = full ? 0 : characters.length - limit;
  const preview =
    hidden > 0 && !expanded
      ? characters.slice(0, limit).join('') + '…(+' + hidden + ' chars)'
      : value;
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <code
          className="whitespace-pre-wrap [overflow-wrap:anywhere]"
          dir="ltr"
        >
          {preview || '""'}
        </code>
        {hidden > 0 && (
          <Button
            type="button"
            size="inline"
            variant="link"
            className="ml-1"
            aria-expanded={expanded}
            aria-label={
              (expanded ? 'Collapse ' : 'Expand ') + label.toLowerCase()
            }
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        )}
      </dd>
    </div>
  );
}

export function McpRepositoryNotice({
  configuration,
}: {
  configuration: McpConfiguration;
}) {
  const repository = configuration.list?.repository;
  if (!repository || !configuration.showDecision) return null;
  return (
    <RepositoryDecision
      key={configuration.decisionKey}
      configuration={configuration}
      repository={repository}
    />
  );
}

function RepositoryDecision({
  configuration,
  repository,
}: {
  configuration: McpConfiguration;
  repository: NonNullable<McpServerList['repository']>;
}) {
  const [raw, setRaw] = useState<typeof repository.rawReview>();
  const [rawError, setRawError] = useState<string>();
  const rawRequest = useRef(0);
  const requiresRawReview = repository.definitions.some(
    definition =>
      definition.change !== 'removed' &&
      definition.launches?.some(launch => launch.requiresRawReview),
  );
  const showRaw = (open: boolean) => {
    const request = ++rawRequest.current;
    if (!open || raw) return;
    setRawError(undefined);
    void configuration.readRaw().then(
      result => {
        if (request === rawRequest.current) setRaw(result);
      },
      error => {
        if (request === rawRequest.current) setRawError(errorDetail(error));
      },
    );
  };
  return (
    <div className="space-y-2">
      <InlineNotice tone="warning">
        <strong className="block text-foreground">
          Trust this repository’s MCP servers and hooks?
        </strong>
        <span className="block">
          {repository.changed
            ? 'Repository definitions changed and are paused until you trust them again.'
            : 'Repository definitions stay paused until you trust them.'}
        </span>
      </InlineNotice>
      <div
        className="max-h-64 space-y-2 overflow-auto px-3 text-xs"
        aria-label="Repository integration details"
        role="region"
        tabIndex={0}
      >
        {repository.definitions.map(definition => (
          <div
            key={definition.id}
            className="border-b border-border pb-2 last:border-b-0"
          >
            <div className="text-muted-foreground [overflow-wrap:anywhere]">
              <strong className="font-medium text-foreground">
                {definition.name}
              </strong>
              {' · '}
              {definition.detail}
              {definition.change
                ? ' · ' +
                  { added: 'Added', changed: 'Changed', removed: 'Removed' }[
                    definition.change
                  ]
                : ''}
            </div>
            {definition.launches?.map((launch, index) => (
              <div key={index} className="mt-1">
                {launch.kind && (
                  <div className="font-medium">{launch.kind}</div>
                )}
                {launch.containsShellExpansion && (
                  <p className="text-warning-foreground">
                    Contains shell expansion
                  </p>
                )}
                {launch.requiresRawReview && (
                  <p className="text-warning-foreground">
                    Review the raw definition
                  </p>
                )}
                <dl>
                  {launch.fields.map((field, fieldIndex) => (
                    <ReviewField
                      key={fieldIndex}
                      full={
                        launch.containsShellExpansion ||
                        launch.requiresRawReview
                      }
                      {...field}
                    />
                  ))}
                </dl>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-1">
        <Dialog onOpenChange={showRaw}>
          <DialogTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              View raw definitions
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Raw repository definitions</DialogTitle>
              <DialogDescription>
                MCP and hook sections from the host’s configuration files. Plain
                credential tokens are masked.
              </DialogDescription>
            </DialogHeader>
            {rawError ? (
              <InlineNotice tone="error">{rawError}</InlineNotice>
            ) : raw ? (
              <div
                className="max-h-[60vh] min-w-0 space-y-4 overflow-auto"
                aria-label="Source files"
                role="region"
                tabIndex={0}
              >
                {raw.files.map(file => (
                  <div key={file.path} className="space-y-1">
                    <p
                      className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
                      dir="ltr"
                    >
                      {file.path}
                    </p>
                    <CodeBlock
                      code={file.text}
                      dir="ltr"
                      className="[overflow-wrap:anywhere]"
                      maxHeightClassName="max-h-none"
                      copyable={false}
                      wrap
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" role="status">
                Loading repository definitions…
              </p>
            )}
          </DialogContent>
        </Dialog>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={configuration.dismiss}
        >
          Not now
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            configuration.pending ||
            configuration.loading ||
            (requiresRawReview && !raw)
          }
          onClick={() => void configuration.trust(raw?.token)}
        >
          Trust
        </Button>
      </div>
      {configuration.error && (
        <InlineNotice tone="error">{configuration.error}</InlineNotice>
      )}
    </div>
  );
}
