import type {
  Computer,
  DesktopApi,
  WorktreeRecipeContent,
  WorktreeRecipeRun,
  WorktreeRecipeStep,
} from '@nesvo/contracts';

export type WorktreeRecipeApi = Pick<
  DesktopApi,
  | 'listWorktreeRecipes'
  | 'saveWorktreeRecipe'
  | 'deleteWorktreeRecipe'
  | 'matchWorktreeRecipe'
  | 'startWorktreeRecipeTrial'
  | 'readWorktreeRecipeTrial'
  | 'stopWorktreeRecipeTrial'
>;

export type SessionWorktreeRecipeApi = Pick<
  DesktopApi,
  'readSessionWorktreeRecipe' | 'decideSessionWorktreeRecipe'
>;

export const supportsWorktreeRecipes = (computer: Computer | undefined) =>
  !!computer?.capabilities.includes('worktree-recipes');

export function worktreeRecipesUnavailableReason(
  computer: Computer | undefined,
) {
  if (!computer) return 'Choose a computer to manage its worktree recipes.';
  if (computer.status !== 'connected')
    return `${computer.name} is offline. Connect it to manage its worktree recipes.`;
  if (!supportsWorktreeRecipes(computer))
    return 'Update this computer’s Nesvo host and reconnect to use worktree recipes.';
  return '';
}

export const recipeStepLabels: Record<WorktreeRecipeStep['kind'], string> = {
  'repository-script': 'Repository setup script',
  copy: 'Copy files',
  setup: 'Setup command',
  cleanup: 'Cleanup command',
};

export const recipeStepStatusLabels: Record<
  WorktreeRecipeStep['status'],
  string
> = {
  pending: 'Waiting',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  'timed-out': 'Timed out',
  stopped: 'Stopped',
  skipped: 'Skipped',
};

export const recipeRunStatusLabels: Record<
  WorktreeRecipeRun['status'],
  string
> = {
  'needs-approval': 'Needs approval',
  running: 'Preparing worktree',
  ready: 'Worktree ready',
  failed: 'Setup failed',
  stopped: 'Setup stopped',
  skipped: 'Recipe skipped',
  interrupted: 'Setup interrupted',
};

export const isRecipeHolding = (run: WorktreeRecipeRun | null) =>
  !!run &&
  !run.released &&
  (run.status === 'needs-approval' || run.status === 'running');

export function formatRecipeBytes(bytes: number) {
  if (bytes >= 1024 * 1024)
    return `${Number((bytes / 1024 / 1024).toFixed(1))} MiB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export function formatRecipeDuration(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export function recipeSummary(recipe: WorktreeRecipeContent) {
  const parts: string[] = [];
  if (recipe.copy.patterns.length)
    parts.push(
      `copies ${recipe.copy.patterns.length} ${recipe.copy.patterns.length === 1 ? 'pattern' : 'patterns'}`,
    );
  if (recipe.setup.command.trim()) parts.push('runs setup');
  if (recipe.resources.ports)
    parts.push(
      `${recipe.resources.ports} ${recipe.resources.ports === 1 ? 'port' : 'ports'}`,
    );
  if (recipe.resources.tag) parts.push('tag');
  if (recipe.resources.tempDirectory) parts.push('temp folder');
  if (recipe.cleanup.command.trim()) parts.push('cleanup');
  return parts.join(' · ') || 'No steps';
}
