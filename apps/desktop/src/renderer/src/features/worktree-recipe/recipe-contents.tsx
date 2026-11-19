import {
  recipeCommandText,
  type WorktreeRecipeRun,
  type WorktreeRecipeSnapshot,
} from '@nesvo/contracts';
import {
  formatRecipeBytes,
  formatRecipeDuration,
} from '@/entities/worktree-recipe';
import { CodeBlock } from '@/shared/ui/code-block';
import { KeyValueList } from '@/shared/ui/key-value-list';

type RecipeContentsProps = {
  recipe: WorktreeRecipeSnapshot;
  repositoryScript?: WorktreeRecipeRun['repositoryScript'];
};

function resourceText({ resources }: WorktreeRecipeSnapshot) {
  const parts = [
    ...(resources.ports
      ? [
          `${resources.ports} unique ${resources.ports === 1 ? 'port' : 'ports'} from ${resources.portRange.from}–${resources.portRange.to} (NESVO_PORT_1${resources.ports > 1 ? `…${resources.ports}` : ''})`,
        ]
      : []),
    ...(resources.tag ? ['resource tag (NESVO_RESOURCE_TAG)'] : []),
    ...(resources.tempDirectory ? ['temporary folder (NESVO_TEMP_DIR)'] : []),
  ];
  return parts.join(', ') || 'None';
}

export function RecipeContents({
  recipe,
  repositoryScript,
}: RecipeContentsProps) {
  const setup = recipeCommandText(recipe.setup.command).trim();
  const cleanup = recipeCommandText(recipe.cleanup.command).trim();
  return (
    <div className="space-y-3">
      <KeyValueList
        entries={[
          {
            key: 'repository',
            label: 'Repository',
            value: recipe.repository.label,
          },
          {
            key: 'files',
            label: 'Copied files',
            value: recipe.copy.patterns.length
              ? `Untracked matches from the main checkout, at most ${recipe.copy.maxFiles} files and ${formatRecipeBytes(recipe.copy.maxBytes)}`
              : 'None',
          },
          { key: 'resources', label: 'Resources', value: resourceText(recipe) },
          ...(repositoryScript
            ? [
                {
                  key: 'script',
                  label: 'Runs first',
                  value: `.nesvo/worktree-setup from the repository${repositoryScript.approved ? '' : ' (also approved by this decision)'}`,
                },
              ]
            : []),
        ]}
      />
      {recipe.copy.patterns.length > 0 && (
        <CodeBlock
          label="Copy patterns"
          code={recipe.copy.patterns.join('\n')}
          maxHeightClassName="max-h-40"
        />
      )}
      {setup && (
        <CodeBlock
          label={`Setup command · in the worktree · ${formatRecipeDuration(recipe.setup.timeoutSeconds)} limit`}
          code={setup}
          wrap
          maxHeightClassName="max-h-48"
        />
      )}
      {recipe.environment.length > 0 && (
        <CodeBlock
          label="Environment"
          code={recipe.environment
            .map(variable => `${variable.name}=${variable.value}`)
            .join('\n')}
          maxHeightClassName="max-h-40"
        />
      )}
      {cleanup && (
        <CodeBlock
          label={`Cleanup command · when the worktree finishes · ${formatRecipeDuration(recipe.cleanup.timeoutSeconds)} limit`}
          code={cleanup}
          wrap
          maxHeightClassName="max-h-40"
        />
      )}
      <p className="font-mono text-2xs break-all text-muted-foreground">
        Recipe SHA-256 {recipe.sha256}
        {repositoryScript && (
          <>
            <br />
            Script SHA-256 {repositoryScript.sha256}
          </>
        )}
      </p>
    </div>
  );
}
