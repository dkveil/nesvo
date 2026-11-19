import { useEffect, useState } from 'react';
import {
  hasLegacyRecipeCommands,
  type DesktopApi,
  type WorktreeRecipeMatch,
} from '@nesvo/contracts';
import { recipeSummary } from '@/entities/worktree-recipe';
import { StatusMessage } from '@/shared/ui/status-message';

const MATCH_DELAY_MS = 300;

type WorktreeRecipeHintProps = {
  api: Pick<DesktopApi, 'matchWorktreeRecipe'>;
  directory: string;
  enabled: boolean;
  boundWorktree: boolean;
};

type MatchState = { directory: string; match: WorktreeRecipeMatch | null };

function repositoryFiles(match: WorktreeRecipeMatch) {
  return [
    ...(match.repositoryIncludes ? ['.worktreeinclude'] : []),
    ...(match.repositoryScript ? ['.nesvo/worktree-setup'] : []),
  ];
}

export function WorktreeRecipeHint({
  api,
  directory,
  enabled,
  boundWorktree,
}: WorktreeRecipeHintProps) {
  const [state, setState] = useState<MatchState | null>(null);
  const folder = directory.trim();
  useEffect(() => {
    if (!enabled || !folder) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.matchWorktreeRecipe({ directory: folder }).then(
        match => {
          if (active) setState({ directory: folder, match });
        },
        () => {
          if (active) setState({ directory: folder, match: null });
        },
      );
    }, MATCH_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, enabled, folder]);
  const match = enabled && state?.directory === folder ? state.match : null;
  if (!match) return null;
  if (boundWorktree) {
    if (!match.recipe && !match.repositoryScript) return null;
    return (
      <StatusMessage tone="info" variant="notice" aria-label="Worktree recipe">
        {match.recipe && !hasLegacyRecipeCommands(match.recipe)
          ? `Review ${match.recipe.name} in the session before setup runs.`
          : match.recipe
            ? 'Replace the legacy shell commands with direct argv in Settings before this recipe can run here.'
            : 'Repository setup scripts are unavailable in this checkout.'}
      </StatusMessage>
    );
  }
  const files = repositoryFiles(match);
  const { recipe } = match;
  if (!recipe)
    return files.length ? (
      <p className="px-2 text-2xs leading-4 text-muted-foreground">
        The repository prepares worktrees with {files.join(' and ')}. No
        worktree recipe is stored for {match.repository.label}.
      </p>
    ) : null;
  return (
    <StatusMessage
      tone="info"
      variant="notice"
      aria-label="Worktree recipe"
      data-worktree-recipe=""
    >
      Recipe {recipe.name} applies: {recipeSummary(recipe)}.{' '}
      {files.length
        ? `The repository’s ${files.join(' and ')} ${files.length === 1 ? 'applies' : 'apply'} first. `
        : ''}
      {recipe.approved &&
      (!match.repositoryScript || match.repositoryScript.approved)
        ? 'It runs as soon as the worktree is created; your first message waits for it.'
        : 'The session asks for approval before it runs; your first message waits.'}
    </StatusMessage>
  );
}
