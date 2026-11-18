import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  worktreeRecipeLimits,
  worktreeRecipeRunSchema,
  worktreeRecipeSchema,
  type WorktreeRecipe,
  type WorktreeRecipeContent,
  type WorktreeRecipeRepository,
  type WorktreeRecipeRun,
} from '@nesvo/contracts';

type Row = Record<string, SQLOutputValue>;

export const installWorktreeRecipeTables = (database: DatabaseSync) => {
  database.exec(
    'CREATE TABLE IF NOT EXISTS worktree_recipes (id TEXT PRIMARY KEY, repository TEXT NOT NULL UNIQUE, document TEXT NOT NULL CHECK (json_valid(document)), updated_at TEXT NOT NULL)',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS worktree_recipe_approvals (sha256 TEXT NOT NULL, git_directory TEXT NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY (sha256, git_directory))',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS worktree_recipe_runs (session_id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK (json_valid(document)), released INTEGER NOT NULL CHECK (released IN (0, 1)), updated_at TEXT NOT NULL)',
  );
};

export const recipeHash = (
  repository: string,
  content: WorktreeRecipeContent,
) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'nesvo-worktree-recipe-1',
        repository,
        content.copy.patterns,
        content.copy.maxFiles,
        content.copy.maxBytes,
        content.setup.command,
        content.setup.timeoutSeconds,
        content.cleanup.command,
        content.cleanup.timeoutSeconds,
        content.environment.map(variable => [variable.name, variable.value]),
        [
          content.resources.ports,
          content.resources.portRange.from,
          content.resources.portRange.to,
          content.resources.tag,
          content.resources.tempDirectory,
        ],
      ]),
    )
    .digest('hex');

export type StoredRecipe = Omit<WorktreeRecipe, 'approved'>;

export class WorktreeRecipeStore {
  constructor(private readonly database: DatabaseSync) {}

  list(): WorktreeRecipe[] {
    return this.database
      .prepare('SELECT document FROM worktree_recipes ORDER BY updated_at DESC')
      .all()
      .map(row => this.toRecipe(row));
  }

  get(id: string): WorktreeRecipe | undefined {
    const row = this.database
      .prepare('SELECT document FROM worktree_recipes WHERE id = ?')
      .get(id);
    return row ? this.toRecipe(row) : undefined;
  }

  forRepository(
    candidates: readonly WorktreeRecipeRepository[],
  ): WorktreeRecipe | undefined {
    for (const candidate of candidates) {
      const row = this.database
        .prepare('SELECT document FROM worktree_recipes WHERE repository = ?')
        .get(candidate.key);
      if (row) return this.toRecipe(row);
    }
    return undefined;
  }

  count(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS total FROM worktree_recipes')
      .get();
    return Number(row?.total ?? 0);
  }

  save(recipe: StoredRecipe): void {
    if (!this.get(recipe.id) && this.count() >= worktreeRecipeLimits.recipes)
      throw new Error(
        `A computer keeps at most ${worktreeRecipeLimits.recipes} recipes.`,
      );
    const document = JSON.stringify(
      worktreeRecipeSchema.parse({ ...recipe, approved: false }),
    );
    this.database
      .prepare(
        'INSERT INTO worktree_recipes (id, repository, document, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET repository = excluded.repository, document = excluded.document, updated_at = excluded.updated_at',
      )
      .run(recipe.id, recipe.repository.key, document, recipe.updatedAt);
  }

  delete(id: string): void {
    this.database.prepare('DELETE FROM worktree_recipes WHERE id = ?').run(id);
  }

  isApproved(sha256: string, gitDirectory?: string): boolean {
    return !!(gitDirectory
      ? this.database
          .prepare(
            'SELECT 1 FROM worktree_recipe_approvals WHERE sha256 = ? AND git_directory = ?',
          )
          .get(sha256, gitDirectory)
      : this.database
          .prepare('SELECT 1 FROM worktree_recipe_approvals WHERE sha256 = ?')
          .get(sha256));
  }

  approve(sha256: string, gitDirectory: string): void {
    this.database
      .prepare(
        'INSERT INTO worktree_recipe_approvals (sha256, git_directory, approved_at) VALUES (?, ?, ?) ON CONFLICT (sha256, git_directory) DO NOTHING',
      )
      .run(sha256, gitDirectory, new Date().toISOString());
  }

  run(sessionId: string): WorktreeRecipeRun | undefined {
    const row = this.database
      .prepare('SELECT document FROM worktree_recipe_runs WHERE session_id = ?')
      .get(sessionId);
    return row ? this.toRun(row) : undefined;
  }

  unreleasedRuns(): WorktreeRecipeRun[] {
    return this.database
      .prepare('SELECT document FROM worktree_recipe_runs WHERE released = 0')
      .all()
      .map(row => this.toRun(row));
  }

  saveRun(run: WorktreeRecipeRun): void {
    if (!run.sessionId) return;
    this.database
      .prepare(
        'INSERT INTO worktree_recipe_runs (session_id, document, released, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET document = excluded.document, released = excluded.released, updated_at = excluded.updated_at',
      )
      .run(
        run.sessionId,
        JSON.stringify(worktreeRecipeRunSchema.parse(run)),
        run.released ? 1 : 0,
        run.updatedAt,
      );
  }

  private toRecipe(row: Row): WorktreeRecipe {
    const recipe = worktreeRecipeSchema.parse(
      JSON.parse(String(row.document)),
    );
    return { ...recipe, approved: this.isApproved(recipe.sha256) };
  }

  private toRun(row: Row): WorktreeRecipeRun {
    return worktreeRecipeRunSchema.parse(JSON.parse(String(row.document)));
  }
}
