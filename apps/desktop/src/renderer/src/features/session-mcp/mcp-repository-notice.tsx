import { Button } from '@/shared/ui/button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import type { McpConfiguration } from './use-mcp-configuration';

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
        <span className="mt-1 block max-h-32 overflow-auto">
          {repository.definitions.map(definition => (
            <span key={definition.id} className="block">
              <span className="font-medium text-foreground">
                {definition.name}
              </span>
              {' · '}
              {definition.detail}
              {definition.change
                ? ' · ' +
                  { added: 'Added', changed: 'Changed', removed: 'Removed' }[
                    definition.change
                  ]
                : ''}
            </span>
          ))}
        </span>
      </InlineNotice>
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
