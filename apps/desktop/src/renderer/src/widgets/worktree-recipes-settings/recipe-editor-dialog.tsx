import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { WorktreeRecipe, WorktreeRecipeMatch } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { WorktreeRecipeApi } from '@/entities/worktree-recipe';
import { Button } from '@/shared/ui/button';
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
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import {
  emptyRecipeValues,
  parseRecipeValues,
  recipeValues,
  type RecipeFormErrors,
  type RecipeFormField,
  type RecipeFormValues,
} from './recipe-form';

const MATCH_DELAY_MS = 400;

type RecipeEditorDialogProps = {
  api: WorktreeRecipeApi;
  computerName: string;
  recipe: WorktreeRecipe | null;
  initialDirectory?: string;
  onOpenChange: (open: boolean) => void;
  onSaved: (recipes: WorktreeRecipe[]) => void;
};

type RepositoryPreview =
  | { directory: string; match: WorktreeRecipeMatch; error: '' }
  | { directory: string; match: null; error: string };

function useRepositoryPreview(api: WorktreeRecipeApi, directory: string) {
  const [preview, setPreview] = useState<RepositoryPreview | null>(null);
  const folder = directory.trim();
  useEffect(() => {
    if (!folder) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.matchWorktreeRecipe({ directory: folder }).then(
        match => {
          if (active) setPreview({ directory: folder, match, error: '' });
        },
        failure => {
          if (active)
            setPreview({
              directory: folder,
              match: null,
              error: errorDetail(failure),
            });
        },
      );
    }, MATCH_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, folder]);
  return preview?.directory === folder ? preview : null;
}

function repositoryHint(
  preview: RepositoryPreview | null,
  recipe: WorktreeRecipe | null,
): ReactNode {
  if (!preview)
    return 'A checkout of the repository on this computer. Files are copied from it.';
  if (!preview.match) return null;
  const { repository, recipe: existing } = preview.match;
  const owner =
    existing && existing.id !== recipe?.id
      ? ` It already has the recipe ${existing.name}; edit that recipe instead.`
      : '';
  return repository.kind === 'remote'
    ? `Applies to every checkout of ${repository.label}, matched by its remote.${owner}`
    : `No remote found, so the recipe applies to ${repository.label} only.${owner}`;
}

export function RecipeEditorDialog({
  api,
  computerName,
  recipe,
  initialDirectory = '',
  onOpenChange,
  onSaved,
}: RecipeEditorDialogProps) {
  const [values, setValues] = useState<RecipeFormValues>(() =>
    recipe ? recipeValues(recipe) : emptyRecipeValues(initialDirectory),
  );
  const [errors, setErrors] = useState<RecipeFormErrors>({});
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);
  const preview = useRepositoryPreview(api, values.directory);
  const change = (patch: Partial<RecipeFormValues>) => {
    setValues(previous => ({ ...previous, ...patch }));
    setErrors(previous => {
      const next = { ...previous };
      for (const key of Object.keys(patch)) delete next[key as RecipeFormField];
      return next;
    });
    setFailure('');
  };
  const messages = (field: RecipeFormField) =>
    errors[field]
      ? [{ severity: 'error' as const, message: errors[field] }]
      : [];
  const described = (field: RecipeFormField, hint = false) =>
    errors[field]
      ? `recipe-${field}-messages`
      : hint
        ? `recipe-${field}-hint`
        : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseRecipeValues(values, recipe?.id ?? null);
    if (!parsed.input) {
      setErrors(parsed.errors);
      return;
    }
    setPending(true);
    setFailure('');
    try {
      onSaved(await api.saveWorktreeRecipe(parsed.input));
      onOpenChange(false);
    } catch (error) {
      setFailure(errorDetail(error));
    } finally {
      setPending(false);
    }
  };
  const text = (
    field: RecipeFormField,
    label: string,
    options: {
      hint?: string;
      placeholder?: string;
      type?: 'number';
      mono?: boolean;
      className?: string;
    } = {},
  ) => (
    <Field
      id={`recipe-${field}`}
      label={label}
      hint={options.hint}
      messages={messages(field)}
      className={options.className}
    >
      <Input
        id={`recipe-${field}`}
        size="md"
        type={options.type}
        min={options.type ? 0 : undefined}
        value={values[field]}
        placeholder={options.placeholder}
        spellCheck={false}
        disabled={pending}
        aria-invalid={!!errors[field]}
        aria-describedby={described(field, !!options.hint)}
        className={options.mono ? 'font-mono' : undefined}
        onChange={event => change({ [field]: event.target.value })}
      />
    </Field>
  );
  const area = (
    field: RecipeFormField,
    label: string,
    hint: string,
    placeholder: string,
  ) => (
    <Field
      id={`recipe-${field}`}
      label={label}
      hint={hint}
      messages={messages(field)}
    >
      <Textarea
        resize="none"
        id={`recipe-${field}`}
        size="md"
        value={values[field]}
        placeholder={placeholder}
        spellCheck={false}
        disabled={pending}
        aria-invalid={!!errors[field]}
        aria-describedby={described(field, true)}
        className="max-h-48 font-mono"
        onChange={event => change({ [field]: event.target.value })}
      />
    </Field>
  );
  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>
              {recipe ? 'Edit worktree recipe' : 'New worktree recipe'}
            </DialogTitle>
            <DialogDescription>
              Stored by {computerName}’s host, outside the repository. New
              session worktrees of this repository run it after you approve this
              exact version once per checkout.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {text('name', 'Name', { placeholder: 'Web app tests' })}
            <Field
              id="recipe-directory"
              label="Repository checkout"
              hint={repositoryHint(preview, recipe)}
              messages={
                errors.directory
                  ? messages('directory')
                  : preview?.error
                    ? [{ severity: 'error', message: preview.error }]
                    : []
              }
            >
              <Input
                id="recipe-directory"
                size="md"
                value={values.directory}
                placeholder="Absolute path on this computer"
                spellCheck={false}
                disabled={pending}
                aria-invalid={!!errors.directory || !!preview?.error}
                aria-describedby="recipe-directory-hint"
                onChange={event => change({ directory: event.target.value })}
              />
            </Field>
          </div>
          <section aria-label="Files" className="grid gap-3">
            <SectionLabel as="h3">Files</SectionLabel>
            {area(
              'patterns',
              'Copy from the main checkout',
              'Git ignore patterns, one per line. Only files absent from the index are copied; existing files are kept.',
              '.env.local\nconfig/*.local.json',
            )}
            <div className="grid grid-cols-2 gap-3">
              {text('maxFiles', 'At most files', { type: 'number' })}
              {text('maxMegabytes', 'Size cap (MiB)', { type: 'number' })}
            </div>
          </section>
          <section aria-label="Commands" className="grid gap-3">
            <SectionLabel as="h3">Commands</SectionLabel>
            {area(
              'setupCommand',
              'Setup command',
              'Runs in the new worktree through the system shell after the files are copied. Output streams into the session.',
              'npm ci',
            )}
            {text('setupMinutes', 'Setup time limit (minutes)', {
              type: 'number',
            })}
            {area(
              'cleanupCommand',
              'Cleanup command',
              'Runs in the worktree when the session worktree is finished or removed, before its resources are released.',
              'docker image rm "app:$NESVO_RESOURCE_TAG"',
            )}
            {text('cleanupMinutes', 'Cleanup time limit (minutes)', {
              type: 'number',
            })}
            {area(
              'environment',
              'Environment',
              'NAME=value per line, given to the commands and the session’s provider. Names starting with NESVO_ are reserved.',
              'APP_ENV=test',
            )}
          </section>
          <section aria-label="Resources" className="grid gap-3">
            <SectionLabel as="h3">Resources</SectionLabel>
            <div className="grid grid-cols-3 gap-3">
              {text('ports', 'Ports', {
                type: 'number',
                hint: 'NESVO_PORT_1…N',
              })}
              {text('portFrom', 'Range from', { type: 'number' })}
              {text('portTo', 'Range to', { type: 'number' })}
            </div>
            <Field
              id="recipe-tag"
              label="Resource tag"
              hint="A unique NESVO_RESOURCE_TAG per session, for example for container image names."
              layout="switch"
            >
              <Switch
                id="recipe-tag"
                aria-describedby="recipe-tag-hint"
                checked={values.tag}
                disabled={pending}
                onCheckedChange={tag => change({ tag })}
              />
            </Field>
            <Field
              id="recipe-temp"
              label="Temporary folder"
              hint="A private NESVO_TEMP_DIR per session, deleted when the worktree finishes."
              layout="switch"
            >
              <Switch
                id="recipe-temp"
                aria-describedby="recipe-temp-hint"
                checked={values.tempDirectory}
                disabled={pending}
                onCheckedChange={tempDirectory => change({ tempDirectory })}
              />
            </Field>
          </section>
          {Object.keys(errors).length > 0 && (
            <StatusMessage tone="error">
              Correct the highlighted fields.
            </StatusMessage>
          )}
          {failure && <StatusMessage tone="error">{failure}</StatusMessage>}
          <DialogFooter>
            <DialogCancel
              disabled={pending}
              onClick={() => onOpenChange(false)}
            />
            <Button
              type="submit"
              size="lg"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? 'Saving…' : 'Save recipe'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
