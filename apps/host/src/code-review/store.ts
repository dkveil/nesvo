import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  codeReviewLimits,
  reviewConventionSchema,
  reviewDraftSchema,
  reviewerProfileSchema,
  type PullRequestReference,
  type ReviewConvention,
  type ReviewDraft,
  type ReviewerProfile,
} from '@nesvo/contracts';

type Row = Record<string, SQLOutputValue>;

export const installCodeReviewTables = (database: DatabaseSync) => {
  database.exec(
    'CREATE TABLE IF NOT EXISTS reviewer_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), document TEXT NOT NULL CHECK (json_valid(document)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS review_conventions (id TEXT PRIMARY KEY, layer TEXT NOT NULL CHECK (layer IN ('global', 'language', 'project')), scope TEXT NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS review_drafts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, number INTEGER NOT NULL, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, scheduled_job_id TEXT REFERENCES scheduled_jobs(id) ON DELETE SET NULL, status TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), document TEXT NOT NULL CHECK (json_valid(document)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS review_drafts_reference ON review_drafts (repository COLLATE NOCASE, number); CREATE INDEX IF NOT EXISTS review_drafts_status ON review_drafts (status); CREATE INDEX IF NOT EXISTS review_drafts_recent ON review_drafts (updated_at DESC)',
  );
};

const document = (row: Row | undefined) =>
  row ? (JSON.parse(String(row.document)) as Record<string, unknown>) : null;

const toDraft = (row: Row): ReviewDraft =>
  reviewDraftSchema.parse({
    ...document(row),
    sessionId: row.session_id ?? null,
    scheduledJobId: row.scheduled_job_id ?? null,
  });

export class CodeReviewStore {
  constructor(private readonly database: DatabaseSync) {}

  transact<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  profiles(): ReviewerProfile[] {
    return this.database
      .prepare('SELECT document FROM reviewer_profiles ORDER BY created_at, id')
      .all()
      .map(row => reviewerProfileSchema.parse(document(row)));
  }

  profile(id: string): ReviewerProfile | undefined {
    const row = document(
      this.database
        .prepare('SELECT document FROM reviewer_profiles WHERE id = ?')
        .get(id),
    );
    return row ? reviewerProfileSchema.parse(row) : undefined;
  }

  saveProfile(profile: ReviewerProfile, expectedRevision: number | null) {
    const valid = reviewerProfileSchema.parse(profile);
    if (expectedRevision === null) {
      this.database
        .prepare(
          'INSERT INTO reviewer_profiles (id, revision, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          valid.id,
          valid.revision,
          JSON.stringify(valid),
          valid.createdAt,
          valid.updatedAt,
        );
      return true;
    }
    return (
      Number(
        this.database
          .prepare(
            'UPDATE reviewer_profiles SET revision = ?, document = ?, updated_at = ? WHERE id = ? AND revision = ?',
          )
          .run(
            valid.revision,
            JSON.stringify(valid),
            valid.updatedAt,
            valid.id,
            expectedRevision,
          ).changes,
      ) === 1
    );
  }

  deleteProfile(id: string, expectedRevision: number): boolean {
    return (
      Number(
        this.database
          .prepare('DELETE FROM reviewer_profiles WHERE id = ? AND revision = ?')
          .run(id, expectedRevision).changes,
      ) === 1
    );
  }

  profileCount(): number {
    return Number(
      this.database
        .prepare('SELECT count(*) AS total FROM reviewer_profiles')
        .get()?.total ?? 0,
    );
  }

  conventions(): ReviewConvention[] {
    return this.database
      .prepare(
        'SELECT document FROM review_conventions ORDER BY layer, scope, created_at, id',
      )
      .all()
      .map(row => reviewConventionSchema.parse(document(row)));
  }

  convention(id: string): ReviewConvention | undefined {
    const row = document(
      this.database
        .prepare('SELECT document FROM review_conventions WHERE id = ?')
        .get(id),
    );
    return row ? reviewConventionSchema.parse(row) : undefined;
  }

  conventionCount(): number {
    return Number(
      this.database
        .prepare('SELECT count(*) AS total FROM review_conventions')
        .get()?.total ?? 0,
    );
  }

  saveConvention(convention: ReviewConvention): void {
    const valid = reviewConventionSchema.parse(convention);
    this.database
      .prepare(
        'INSERT INTO review_conventions (id, layer, scope, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET layer = excluded.layer, scope = excluded.scope, document = excluded.document, updated_at = excluded.updated_at',
      )
      .run(
        valid.id,
        valid.layer,
        valid.scope,
        JSON.stringify(valid),
        valid.createdAt,
        valid.updatedAt,
      );
  }

  deleteConvention(id: string): boolean {
    return (
      Number(
        this.database
          .prepare('DELETE FROM review_conventions WHERE id = ?')
          .run(id).changes,
      ) === 1
    );
  }

  draft(id: string): ReviewDraft | undefined {
    const row = this.database
      .prepare('SELECT * FROM review_drafts WHERE id = ?')
      .get(id);
    return row ? toDraft(row) : undefined;
  }

  draftForRequest(requestId: string): ReviewDraft | undefined {
    const row = this.database
      .prepare('SELECT * FROM review_drafts WHERE request_id = ?')
      .get(requestId);
    return row ? toDraft(row) : undefined;
  }

  drafts(reference?: PullRequestReference): ReviewDraft[] {
    const rows = reference
      ? this.database
          .prepare(
            'SELECT * FROM review_drafts WHERE repository = ? COLLATE NOCASE AND number = ? ORDER BY created_at DESC, id LIMIT ?',
          )
          .all(reference.repository, reference.number, codeReviewLimits.drafts)
      : this.database
          .prepare(
            'SELECT * FROM review_drafts ORDER BY updated_at DESC, id LIMIT ?',
          )
          .all(codeReviewLimits.drafts);
    return rows.map(toDraft);
  }

  draftsWithStatus(statuses: readonly ReviewDraft['status'][]): ReviewDraft[] {
    return this.database
      .prepare(
        `SELECT * FROM review_drafts WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at, id`,
      )
      .all(...statuses)
      .map(toDraft);
  }

  insertDraft(draft: ReviewDraft, requestId: string): void {
    const valid = reviewDraftSchema.parse(draft);
    this.database
      .prepare(
        'INSERT INTO review_drafts (id, request_id, repository, number, session_id, scheduled_job_id, status, revision, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        valid.id,
        requestId,
        valid.reference.repository,
        valid.reference.number,
        valid.sessionId,
        valid.scheduledJobId,
        valid.status,
        valid.revision,
        JSON.stringify(valid),
        valid.createdAt,
        valid.updatedAt,
      );
  }

  replaceDraft(draft: ReviewDraft, expectedRevision: number): boolean {
    const valid = reviewDraftSchema.parse(draft);
    return (
      Number(
        this.database
          .prepare(
            'UPDATE review_drafts SET session_id = ?, status = ?, revision = ?, document = ?, updated_at = ? WHERE id = ? AND revision = ?',
          )
          .run(
            valid.sessionId,
            valid.status,
            valid.revision,
            JSON.stringify(valid),
            valid.updatedAt,
            valid.id,
            expectedRevision,
          ).changes,
      ) === 1
    );
  }
}
