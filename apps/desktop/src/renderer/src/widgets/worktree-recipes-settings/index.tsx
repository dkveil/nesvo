import { useEffect, useState } from 'react';
import type { Computer, WorktreeRecipe } from '@nesvo/contracts';
import { FlaskConical, Pencil, Plus, Trash2 } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import {
  recipeSummary,
  worktreeRecipesUnavailableReason,
  type WorktreeRecipeApi,
} from '@/entities/worktree-recipe';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { IconButton } from '@/shared/ui/icon-button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { RecipeEditorDialog } from './recipe-editor-dialog';
import { RecipeTrialDialog } from './recipe-trial-dialog';

type WorktreeRecipesSettingsProps = {
  computer: Computer | undefined;
  api: WorktreeRecipeApi;
};

type Editing = { recipe: WorktreeRecipe | null } | null;

export function WorktreeRecipesSettings({
  computer,
  api,
}: WorktreeRecipesSettingsProps) {
  const unavailable = worktreeRecipesUnavailableReason(computer);
  const [recipes, setRecipes] = useState<WorktreeRecipe[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [testing, setTesting] = useState<WorktreeRecipe | null>(null);
  const [deleting, setDeleting] = useState<WorktreeRecipe | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (unavailable) return;
    let active = true;
    void api.listWorktreeRecipes().then(
      list => {
        if (active) setRecipes(list);
      },
      failure => {
        if (active) setError(errorDetail(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, unavailable]);
  if (unavailable) return <InlineNotice>{unavailable}</InlineNotice>;
  const remove = async (recipe: WorktreeRecipe) => {
    setPending(true);
    setError('');
    try {
      setRecipes(await api.deleteWorktreeRecipe({ id: recipe.id }));
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  const computerName = computer?.name ?? 'This computer';
  return (
    <div className="space-y-6">
      <p className="text-xs leading-5 text-muted-foreground">
        A recipe prepares every new session worktree of a repository: it copies
        ignored files such as <span className="font-mono">.env.local</span> from
        the main checkout, runs a setup command and gives the session unique
        ports, a resource tag and a temporary folder. Recipes are stored by{' '}
        {computerName}’s host, so the repository stays untouched.
      </p>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      <SettingsSection
        title="Worktree recipes"
        action={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending || !recipes}
            aria-haspopup="dialog"
            onClick={() => setEditing({ recipe: null })}
          >
            <Plus />
            New recipe
          </Button>
        }
      >
        {!recipes && !error ? (
          <SkeletonList
            label="Loading worktree recipes"
            density="two-line"
            rows={2}
          />
        ) : !recipes?.length ? (
          <SettingsRow
            title="No worktree recipes"
            description="Add a recipe for a repository so its session worktrees start ready for tests."
          />
        ) : (
          recipes.map(recipe => (
            <SettingsRow
              key={recipe.id}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {recipe.name}
                  <Badge tone={recipe.approved ? 'success' : 'neutral'}>
                    {recipe.approved ? 'Approved' : 'Not approved'}
                  </Badge>
                </span>
              }
              description={
                <>
                  <span className="block">{recipe.repository.label}</span>
                  <span className="block">{recipeSummary(recipe)}</span>
                </>
              }
            >
              <IconButton
                label={`Test ${recipe.name}`}
                disabled={pending}
                onClick={() => setTesting(recipe)}
              >
                <FlaskConical />
              </IconButton>
              <IconButton
                label={`Edit ${recipe.name}`}
                disabled={pending}
                onClick={() => setEditing({ recipe })}
              >
                <Pencil />
              </IconButton>
              <IconButton
                label={`Delete ${recipe.name}`}
                tone="danger"
                disabled={pending}
                onClick={() => setDeleting(recipe)}
              >
                <Trash2 />
              </IconButton>
            </SettingsRow>
          ))
        )}
      </SettingsSection>
      {editing && (
        <RecipeEditorDialog
          api={api}
          computerName={computerName}
          recipe={editing.recipe}
          onOpenChange={open => {
            if (!open) setEditing(null);
          }}
          onSaved={setRecipes}
        />
      )}
      {testing && (
        <RecipeTrialDialog
          api={api}
          recipe={testing}
          onOpenChange={open => {
            if (!open) setTesting(null);
          }}
        />
      )}
      <ConfirmDialog
        surface="panel"
        open={!!deleting}
        onOpenChange={open => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? 'recipe'}?`}
        description="New session worktrees of this repository start without it. Sessions that already ran it keep their resources until their worktree finishes."
        confirmLabel="Delete recipe"
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      />
    </div>
  );
}
