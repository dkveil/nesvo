import { Button } from '@/shared/ui/button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import type { McpRepositoryLaunch } from '@nesvo/contracts';
import { useState } from 'react';
import type { McpConfiguration } from './use-mcp-configuration';

function ReviewField({ label, value }: McpRepositoryLaunch['fields'][number]) {
  const [expanded, setExpanded] = useState(false);
  const limit = 104;
  const characters = Array.from(value);
  const hidden = characters.length - limit;
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
        key={repository.fingerprint}
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
                <dl>
                  {launch.fields.map((field, fieldIndex) => (
                    <ReviewField key={fieldIndex} {...field} />
                  ))}
                </dl>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-1">
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
          disabled={configuration.pending || configuration.loading}
          onClick={() => void configuration.trust()}
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
