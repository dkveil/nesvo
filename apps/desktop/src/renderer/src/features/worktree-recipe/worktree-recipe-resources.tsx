import type { RunningApp, WorktreeRecipeRun } from '@nesvo/contracts';
import { ExternalLink } from 'lucide-react';
import { recipeRunStatusLabels } from '@/entities/worktree-recipe';
import { Button } from '@/shared/ui/button';
import { KeyValueList } from '@/shared/ui/key-value-list';

type WorktreeRecipeResourcesProps = {
  run: WorktreeRecipeRun;
  runningApps: readonly RunningApp[];
  local: boolean;
};

function PortValue({
  port,
  app,
  local,
}: {
  port: number;
  app: RunningApp | undefined;
  local: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono tabular-nums">:{port}</span>
      {app && (
        <span className="text-muted-foreground">
          {app.name || `Process ${app.pid}`} listening
        </span>
      )}
      {app?.web && local && (
        <Button
          type="button"
          size="xs"
          variant="link"
          aria-label={`Open localhost:${port}`}
          onClick={() =>
            void window.nesvo
              .openExternal(`http://localhost:${port}`)
              .catch(() => undefined)
          }
        >
          Open
          <ExternalLink aria-hidden="true" />
        </Button>
      )}
    </span>
  );
}

export function WorktreeRecipeResources({
  run,
  runningApps,
  local,
}: WorktreeRecipeResourcesProps) {
  const resources = run.released ? null : run.resources;
  return (
    <section aria-label="Worktree recipe" className="space-y-4">
      <h2 className="text-xs font-medium">Worktree recipe</h2>
      <KeyValueList
        density="comfortable"
        entries={[
          { key: 'recipe', label: 'Recipe', value: run.recipe.name },
          {
            key: 'status',
            label: 'Status',
            value: run.released
              ? `${recipeRunStatusLabels[run.status]} · resources released`
              : recipeRunStatusLabels[run.status],
          },
          ...(resources?.ports.length
            ? resources.ports.map((port, index) => ({
                key: `port-${port}`,
                label: `NESVO_PORT_${index + 1}`,
                value: (
                  <PortValue
                    port={port}
                    app={runningApps.find(app => app.port === port)}
                    local={local}
                  />
                ),
              }))
            : []),
          ...(resources?.tag
            ? [
                {
                  key: 'tag',
                  label: 'Resource tag',
                  value: <span className="font-mono">{resources.tag}</span>,
                },
              ]
            : []),
          ...(resources?.tempDirectory
            ? [
                {
                  key: 'temp',
                  label: 'Temporary folder',
                  value: resources.tempDirectory,
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}
