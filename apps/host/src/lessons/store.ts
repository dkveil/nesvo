import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  defaultLessonSettings,
  lessonIncidentSchema,
  lessonLimits,
  lessonProposalStateSchema,
  lessonSettingsSchema,
  type LessonIncident,
  type LessonMetrics,
  type LessonProposalState,
  type LessonSettings,
} from '@nesvo/contracts';

type Row = Record<string, SQLOutputValue>;

const SETTINGS_KEY = 'lesson-settings';
const PROPOSAL_KEY = 'lesson-proposal';
const NUMBER_KEY = 'lesson-next-number';

export const idleProposal: LessonProposalState = {
  status: 'idle',
  proposalId: null,
  sessionId: null,
  startedAt: null,
  finishedAt: null,
  proposed: 0,
  dropped: 0,
  error: null,
};

export const installLessonTables = (database: DatabaseSync) => {
  database.exec(
    'CREATE TABLE IF NOT EXISTS lesson_incidents (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at TEXT NOT NULL, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL, proposed_at TEXT, document TEXT NOT NULL CHECK (json_valid(document)))',
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS lesson_incidents_recent ON lesson_incidents (at DESC, id); CREATE INDEX IF NOT EXISTS lesson_incidents_pending ON lesson_incidents (at DESC) WHERE proposed_at IS NULL',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS rule_entry_metrics (entry_key TEXT PRIMARY KEY, delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered >= 0), cited INTEGER NOT NULL DEFAULT 0 CHECK (cited >= 0), last_delivered TEXT, last_cited TEXT)',
  );
};

const toIncident = (row: Row): LessonIncident =>
  lessonIncidentSchema.parse({
    ...(JSON.parse(String(row.document)) as object),
    sessionId: row.session_id ?? null,
    workflowRunId: row.workflow_run_id ?? null,
    proposedAt: row.proposed_at ?? null,
  });

export class LessonStore {
  constructor(private readonly database: DatabaseSync) {}

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

  claimNumber(atLeast: number, maximum: number): number {
    const stored = Number(this.metadata(NUMBER_KEY) ?? 1);
    const next = Math.max(
      Number.isSafeInteger(stored) && stored > 0 ? stored : 1,
      atLeast,
    );
    if (next > maximum)
      throw new Error('No lesson numbers are left on this computer.');
    this.setMetadata(NUMBER_KEY, next + 1);
    return next;
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

  incidentsById(ids: readonly string[]): LessonIncident[] {
    if (!ids.length) return [];
    return this.database
      .prepare(
        `SELECT * FROM lesson_incidents WHERE id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids)
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

  metrics(keys: readonly string[]): Map<string, LessonMetrics> {
    const found = new Map<string, LessonMetrics>();
    if (!keys.length) return found;
    for (const row of this.database
      .prepare(
        `SELECT * FROM rule_entry_metrics WHERE entry_key IN (${keys.map(() => '?').join(', ')})`,
      )
      .all(...keys))
      found.set(String(row.entry_key), {
        delivered: Number(row.delivered),
        cited: Number(row.cited),
        lastDelivered: row.last_delivered ? String(row.last_delivered) : null,
        lastCited: row.last_cited ? String(row.last_cited) : null,
      });
    return found;
  }

  recordDelivery(keys: readonly string[], at: string): void {
    const upsert = this.database.prepare(
      'INSERT INTO rule_entry_metrics (entry_key, delivered, last_delivered) VALUES (?, 1, ?) ON CONFLICT(entry_key) DO UPDATE SET delivered = delivered + 1, last_delivered = excluded.last_delivered',
    );
    for (const key of keys) upsert.run(key, at);
  }

  recordCitations(keys: readonly string[], at: string): void {
    const update = this.database.prepare(
      'UPDATE rule_entry_metrics SET cited = cited + 1, last_cited = ? WHERE entry_key = ?',
    );
    for (const key of new Set(keys)) update.run(at, key);
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
