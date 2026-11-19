import {
  recipeCommandText,
  saveWorktreeRecipeSchema,
  worktreeRecipeDefaults,
  type SaveWorktreeRecipeInput,
  type WorktreeRecipe,
} from '@nesvo/contracts';

export type RecipeFormValues = {
  name: string;
  directory: string;
  patterns: string;
  maxFiles: string;
  maxMegabytes: string;
  setupCommand: string;
  setupMinutes: string;
  cleanupCommand: string;
  cleanupMinutes: string;
  environment: string;
  ports: string;
  portFrom: string;
  portTo: string;
  tag: boolean;
  tempDirectory: boolean;
};

export type RecipeFormField = Exclude<
  keyof RecipeFormValues,
  'tag' | 'tempDirectory'
>;

export type RecipeFormErrors = Partial<Record<RecipeFormField, string>>;

const MEBIBYTE = 1024 * 1024;

export const emptyRecipeValues = (directory = ''): RecipeFormValues => ({
  name: '',
  directory,
  patterns: '.env.local',
  maxFiles: String(worktreeRecipeDefaults.maxFiles),
  maxMegabytes: String(worktreeRecipeDefaults.maxBytes / MEBIBYTE),
  setupCommand: '',
  setupMinutes: String(worktreeRecipeDefaults.setupTimeoutSeconds / 60),
  cleanupCommand: '',
  cleanupMinutes: String(worktreeRecipeDefaults.cleanupTimeoutSeconds / 60),
  environment: '',
  ports: '2',
  portFrom: String(worktreeRecipeDefaults.portRange.from),
  portTo: String(worktreeRecipeDefaults.portRange.to),
  tag: true,
  tempDirectory: true,
});

export const recipeValues = (recipe: WorktreeRecipe): RecipeFormValues => ({
  name: recipe.name,
  directory: recipe.sourceDirectory ?? '',
  patterns: recipe.copy.patterns.join('\n'),
  maxFiles: String(recipe.copy.maxFiles),
  maxMegabytes: String(Number((recipe.copy.maxBytes / MEBIBYTE).toFixed(2))),
  setupCommand: recipeCommandText(recipe.setup.command),
  setupMinutes: String(Number((recipe.setup.timeoutSeconds / 60).toFixed(2))),
  cleanupCommand: recipeCommandText(recipe.cleanup.command),
  cleanupMinutes: String(
    Number((recipe.cleanup.timeoutSeconds / 60).toFixed(2)),
  ),
  environment: recipe.environment
    .map(variable => `${variable.name}=${variable.value}`)
    .join('\n'),
  ports: String(recipe.resources.ports),
  portFrom: String(recipe.resources.portRange.from),
  portTo: String(recipe.resources.portRange.to),
  tag: recipe.resources.tag,
  tempDirectory: recipe.resources.tempDirectory,
});

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

const wholeNumber = (text: string) =>
  /^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN;

const seconds = (minutes: string) => {
  const value = Number(minutes);
  return Number.isFinite(value) && minutes.trim()
    ? Math.round(value * 60)
    : Number.NaN;
};

const fieldScale: Partial<Record<RecipeFormField, number>> = {
  maxMegabytes: MEBIBYTE,
  setupMinutes: 60,
  cleanupMinutes: 60,
};

const issueField = (path: PropertyKey[]): RecipeFormField => {
  const [group, field, detail] = path.map(String);
  if (group === 'copy')
    return field === 'maxFiles'
      ? 'maxFiles'
      : field === 'maxBytes'
        ? 'maxMegabytes'
        : 'patterns';
  if (group === 'setup')
    return field === 'command' ? 'setupCommand' : 'setupMinutes';
  if (group === 'cleanup')
    return field === 'command' ? 'cleanupCommand' : 'cleanupMinutes';
  if (group === 'environment') return 'environment';
  if (group === 'resources')
    return field === 'ports'
      ? 'ports'
      : detail === 'from'
        ? 'portFrom'
        : 'portTo';
  return group === 'directory' ? 'directory' : 'name';
};

export function parseRecipeValues(
  values: RecipeFormValues,
  id: string | null,
):
  | { input: SaveWorktreeRecipeInput; errors: null }
  | { input: null; errors: RecipeFormErrors } {
  const errors: RecipeFormErrors = {};
  const command = (field: 'setupCommand' | 'cleanupCommand'): unknown => {
    const value = values[field].trim();
    if (!value.startsWith('{')) return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      errors[field] = 'Enter a valid direct-argv JSON object.';
      return value;
    }
  };
  const environment = lines(values.environment).map(line => {
    const separator = line.indexOf('=');
    if (separator < 1) errors.environment = 'Write one NAME=value per line.';
    return {
      name: line.slice(0, Math.max(separator, 0)),
      value: line.slice(separator + 1),
    };
  });
  const parsed = saveWorktreeRecipeSchema.safeParse({
    id,
    name: values.name,
    directory: values.directory,
    copy: {
      patterns: lines(values.patterns),
      maxFiles: wholeNumber(values.maxFiles),
      maxBytes: Math.round(Number(values.maxMegabytes) * MEBIBYTE),
    },
    setup: {
      command: command('setupCommand'),
      timeoutSeconds: seconds(values.setupMinutes),
    },
    cleanup: {
      command: command('cleanupCommand'),
      timeoutSeconds: seconds(values.cleanupMinutes),
    },
    environment,
    resources: {
      ports: wholeNumber(values.ports),
      portRange: {
        from: wholeNumber(values.portFrom),
        to: wholeNumber(values.portTo),
      },
      tag: values.tag,
      tempDirectory: values.tempDirectory,
    },
  });
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = issueField(issue.path);
      const scale = fieldScale[field] ?? 1;
      errors[field] ??=
        issue.code === 'invalid_type'
          ? 'Enter a value.'
          : issue.code === 'too_big' && issue.origin === 'number'
            ? `Use at most ${Number(issue.maximum) / scale}.`
            : issue.code === 'too_small' && issue.origin === 'number'
              ? `Use at least ${Number(issue.minimum) / scale}.`
              : issue.message;
    }
  if (Object.keys(errors).length || !parsed.success)
    return { input: null, errors };
  return { input: parsed.data, errors: null };
}
