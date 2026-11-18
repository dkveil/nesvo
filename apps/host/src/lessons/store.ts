import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  defaultLessonSettings,
  lessonIncidentSchema,
  lessonLimits,
  lessonProposalStateSchema,
  lessonSchema,
  lessonSettingsSchema,
  type Lesson,
  type LessonIncident,
  type LessonProposalState,
  type LessonSettings,
} from '@nesvo/contracts';

type Row = Record<string, SQLOutputValue>;

const SETTINGS_KEY = 'lesson-settings';
const PROPOSAL_KEY = 'lesson-proposal';

export const idleProposal: LessonProposalState = {
  status: 'idle',
  proposalId: null,
  sessionId: null,
  startedAt: null,
  finishedAt: null,
  proposed: 0,
  error: null,
};

export const installLessonTables = (database: DatabaseSync) => {
  database.exec(
    "CREATE TABLE IF NOT EXISTS lesson_incidents (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at TEXT NOT NULL, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL, proposed_at TEXT, document TEXT NOT NULL CHECK (json_valid(document)))",
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS lesson_incidents_recent ON lesson_incidents (at DESC, id); CREATE INDEX IF NOT EXISTS lesson_incidents_pending ON lesson_incidents (at DESC) WHERE proposed_at IS NULL',
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS lesson_proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('proposed', 'rejected')), version TEXT NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS lesson_proposals_status ON lesson_proposals (status, updated_at DESC)',
  );
};

const parsed = (row: Row) => JSON.parse(String(row.document)) as unknown;

const toIncident = (row: Row): LessonIncident =>
  lessonIncidentSchema.parse({
    ...(parsed(row) as object),
    sessionId: row.session_id ?? null,
    workflowRunId: row.workflow_run_id ?? null,
    proposedAt: row.proposed_at ?? null,
  });

export class LessonStore {
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

  settings(): LessonSettings {
    const value = this.metadata(SETTINGS_KEY);
    const settings = value ? lessonSettingsSchema.safeParse(value) : null;
    return settings?.success ? settings.data : defaultLessonSettings;
  }

  saveSettings(settings: LessonSettings): void {
    this.setMetadata(SETTINGS_KEY, lessonSettingsSchema.parse(settings));
  }

  proposalState(): LessonProposalState {
    const value = this.metadata(PROPOSAL_KEY);
    const state = value ? lessonProposalStateSchema.safeParse(value) : null;
    return state?.success ? state.data : idleProposal;
  }

  saveProposalState(state: LessonProposalState): void {
    this.setMetadata(PROPOSAL_KEY, lessonProposalStateSchema.parse(state));
  }

  recordIncident(incident: LessonIncident, fingerprint: string): boolean {
    const valid = lessonIncidentSchema.parse(incident);
    const inserted = Number(
      this.database
        .prepare(
          'INSERT OR IGNORE INTO lesson_incidents (id, fingerprint, kind, at, session_id, workflow_run_id, proposed_at, document) VALUES (?, ?, ?, ?, (SELECT id FROM sessions WHERE id = ?), (SELECT id FROM workflow_runs WHERE id = ?), ?, ?)',
        )
        .run(
          valid.id,
          fingerprint,
          valid.kind,
          valid.at,
          valid.sessionId,
          valid.workflowRunId,
          valid.proposedAt,
          JSON.stringify(valid),
        ).changes,
    );
    if (inserted)
      this.database
        .prepare(
          'DELETE FROM lesson_incidents WHERE id IN (SELECT id FROM lesson_incidents ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)',
        )
        .run(lessonLimits.incidents);
    return inserted === 1;
  }

  incidents(limit: number = lessonLimits.listedIncidents): LessonIncident[] {
    return this.database
      .prepare('SELECT * FROM lesson_incidents ORDER BY at DESC, id LIMIT ?')
      .all(limit)
      .map(toIncident);
  }

  pendingIncidents(limit: number): LessonIncident[] {
    return this.database
      .prepare(
        'SELECT * FROM lesson_incidents WHERE proposed_at IS NULL ORDER BY at DESC, id LIMIT ?',
      )
      .all(limit)
      .map(toIncident);
  }

  pendingCount(): number {
    return Number(
      this.database
        .prepare(
          'SELECT count(*) AS total FROM lesson_incidents WHERE proposed_at IS NULL',
        )
        .get()?.total ?? 0,
    );
  }

  markProposed(ids: readonly string[], at: string): void {
    const update = this.database.prepare(
      'UPDATE lesson_incidents SET proposed_at = ? WHERE id = ? AND proposed_at IS NULL',
    );
    for (const id of ids) update.run(at, id);
  }

  proposals(): Lesson[] {
    return this.database
      .prepare(
        "SELECT document FROM lesson_proposals ORDER BY CASE status WHEN 'proposed' THEN 0 ELSE 1 END, updated_at DESC, id LIMIT ?",
      )
      .all(lessonLimits.proposals)
      .map(row => lessonSchema.parse(parsed(row)));
  }

  proposalRecord(id: string): Lesson | undefined {
    const row = this.database
      .prepare('SELECT document FROM lesson_proposals WHERE id = ?')
      .get(id);
    return row ? lessonSchema.parse(parsed(row)) : undefined;
  }

  proposalCount(): number {
    return Number(
      this.database
        .prepare('SELECT count(*) AS total FROM lesson_proposals')
        .get()?.total ?? 0,
    );
  }

  insertProposal(lesson: Lesson): void {
    const valid = lessonSchema.parse(lesson);
    this.database
      .prepare(
        'INSERT INTO lesson_proposals (id, status, version, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        valid.id,
        valid.status,
        valid.version,
        JSON.stringify(valid),
        valid.createdAt,
        valid.updatedAt,
      );
  }

  replaceProposal(lesson: Lesson, expectedVersion: string): boolean {
    const valid = lessonSchema.parse(lesson);
    return (
      Number(
        this.database
          .prepare(
            'UPDATE lesson_proposals SET status = ?, version = ?, document = ?, updated_at = ? WHERE id = ? AND version = ?',
          )
          .run(
            valid.status,
            valid.version,
            JSON.stringify(valid),
            valid.updatedAt,
            valid.id,
            expectedVersion,
          ).changes,
      ) === 1
    );
  }

  deleteProposal(id: string, expectedVersion: string): boolean {
    return (
      Number(
        this.database
          .prepare('DELETE FROM lesson_proposals WHERE id = ? AND version = ?')
          .run(id, expectedVersion).changes,
      ) === 1
    );
  }

  private metadata(key: string): unknown {
    const row = this.database
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(key);
    if (!row) return null;
    try {
      return JSON.parse(String(row.value));
    } catch {
      return null;
    }
  }

  private setMetadata(key: string, value: unknown): void {
    this.database
      .prepare(
        'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
}
