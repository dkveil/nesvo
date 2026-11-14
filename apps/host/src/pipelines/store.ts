import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  pipelineLimits,
  pipelineRunSchema,
  pipelineStepRecordSchema,
  type PipelineRun,
  type PipelineRunPage,
  type PipelineRunStatus,
  type PipelineStepRecord,
} from '@nesvo/contracts';

export const PIPELINE_RUN_RETENTION = pipelineLimits.finishedRunsPerProject;
export const EXTERNAL_ACTION_ATTENTION = 'External action may have run.';

const RUNNING_STATUSES: readonly PipelineRunStatus[] = [
  'planning',
  'implementing',
  'checking',
  'fixing',
];
const IN_PROGRESS_STATUSES: readonly PipelineRunStatus[] = [
  'pending',
  ...RUNNING_STATUSES,
  'awaiting-human',
];
const FINISHED_STATUSES: readonly PipelineRunStatus[] = [
  'passed',
  'failed',
  'rejected',
  'stopped',
];

type Row = Record<string, SQLOutputValue>;

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-fA-F-]{36})$/;

const toRun = (row: Row): PipelineRun =>
  pipelineRunSchema.parse(JSON.parse(String(row.document)));

const toStep = (row: Row): PipelineStepRecord =>
  pipelineStepRecordSchema.parse(JSON.parse(String(row.document)));

const quoted = (values: readonly string[]) =>
  values.map(value => `'${value}'`).join(', ');

const IN_PROGRESS_SQL = quoted(IN_PROGRESS_STATUSES);
const RUNNING_SQL = quoted(RUNNING_STATUSES);
const RECOVERABLE_SQL = quoted(['pending', ...RUNNING_STATUSES]);
const FINISHED_SQL = quoted(FINISHED_STATUSES);
const TERMINAL_SQL = quoted([...FINISHED_STATUSES, 'interrupted']);

const runValues = (run: PipelineRun) => [
  run.revision,
  run.directory,
  run.projectRoot,
  run.pipeline.name,
  run.specPath,
  run.specHash,
  JSON.stringify(run),
  run.status,
  run.phase,
  run.currentStepIndex,
  run.sessionId,
  run.updatedAt,
  run.finishedAt,
];

const stepValues = (step: PipelineStepRecord) => [
  step.revision,
  step.index,
  step.name,
  step.type,
  step.phase,
  step.state,
  step.attempt,
  JSON.stringify(step),
  step.sessionId,
  step.reviewId,
  step.reviewVersion,
  step.startedAt,
  step.updatedAt,
];

export class PipelineRunStore {
  constructor(private readonly database: DatabaseSync) {}

  transact<T>(work: () => T): T {
    if (this.database.isTransaction) return work();
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

  insertRun(run: PipelineRun): boolean {
    return this.transact(
      () =>
        Number(
          this.database
            .prepare(
              'INSERT INTO pipeline_runs (revision, directory, project_root, pipeline_name, spec_path, spec_hash, document, status, phase, current_step_index, session_id, updated_at, finished_at, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
            )
            .run(...runValues(run), run.id, run.createdAt).changes,
        ) === 1,
    );
  }

  replaceRun(run: PipelineRun, expectedRevision: number): boolean {
    return this.transact(
      () =>
        Number(
          this.database
            .prepare(
              'UPDATE pipeline_runs SET revision = ?, directory = ?, project_root = ?, pipeline_name = ?, spec_path = ?, spec_hash = ?, document = ?, status = ?, phase = ?, current_step_index = ?, session_id = ?, updated_at = ?, finished_at = ? WHERE id = ? AND revision = ?',
            )
            .run(...runValues(run), run.id, expectedRevision).changes,
        ) === 1,
    );
  }

  getRun(id: string): PipelineRun | undefined {
    const row = this.database
      .prepare('SELECT document FROM pipeline_runs WHERE id = ?')
      .get(id);
    return row ? toRun(row) : undefined;
  }

  listRuns(cursor: string | null, limit: number): PipelineRunPage | undefined {
    const position = cursor ? CURSOR_PATTERN.exec(cursor) : null;
    if (cursor && !position) return undefined;
    const size = Math.min(limit, pipelineLimits.runPage);
    const rows = (
      position
        ? this.database
            .prepare(
              'SELECT document FROM pipeline_runs WHERE updated_at < ? OR (updated_at = ? AND id < ?) ORDER BY updated_at DESC, id DESC LIMIT ?',
            )
            .all(position[1]!, position[1]!, position[2]!, size + 1)
        : this.database
            .prepare(
              'SELECT document FROM pipeline_runs ORDER BY updated_at DESC, id DESC LIMIT ?',
            )
            .all(size + 1)
    ).map(toRun);
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      runs: page,
      nextCursor:
        rows.length > size && last ? `${last.updatedAt}|${last.id}` : null,
    };
  }

  activeRunForDirectory(projectRoot: string): PipelineRun | undefined {
    const row = this.database
      .prepare(
        `SELECT document FROM pipeline_runs WHERE project_root = ? AND status IN (${IN_PROGRESS_SQL}) ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectRoot);
    return row ? toRun(row) : undefined;
  }

  activeRunsForPipeline(
    name: string,
    projectRoot: string | null,
  ): PipelineRun[] {
    const rows = this.database
      .prepare(
        `SELECT document FROM pipeline_runs WHERE pipeline_name = ? AND (? IS NULL OR project_root = ?) AND status IN (${IN_PROGRESS_SQL}) ORDER BY created_at DESC, id DESC`,
      )
      .all(name, projectRoot, projectRoot);
    return rows.map(toRun);
  }

  insertStep(step: PipelineStepRecord): boolean {
    return this.transact(
      () =>
        Number(
          this.database
            .prepare(
              'INSERT INTO pipeline_steps (revision, step_index, name, type, phase, state, attempt, document, session_id, review_id, review_version, started_at, updated_at, id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
            )
            .run(...stepValues(step), step.id, step.runId).changes,
        ) === 1,
    );
  }

  replaceStep(step: PipelineStepRecord, expectedRevision: number): boolean {
    return this.transact(
      () =>
        Number(
          this.database
            .prepare(
              'UPDATE pipeline_steps SET revision = ?, step_index = ?, name = ?, type = ?, phase = ?, state = ?, attempt = ?, document = ?, session_id = ?, review_id = ?, review_version = ?, started_at = ?, updated_at = ? WHERE id = ? AND revision = ?',
            )
            .run(...stepValues(step), step.id, expectedRevision).changes,
        ) === 1,
    );
  }

  getStep(id: string): PipelineStepRecord | undefined {
    const row = this.database
      .prepare('SELECT document FROM pipeline_steps WHERE id = ?')
      .get(id);
    return row ? toStep(row) : undefined;
  }

  stepsForRun(runId: string): PipelineStepRecord[] {
    return this.database
      .prepare(
        'SELECT document FROM pipeline_steps WHERE run_id = ? ORDER BY step_index, attempt',
      )
      .all(runId)
      .map(toStep);
  }

  stepByDecision(decisionId: string): PipelineStepRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT document FROM pipeline_steps WHERE json_extract(document, '$.decision.decisionId') = ?",
      )
      .get(decisionId);
    return row ? toStep(row) : undefined;
  }

  isGatePending(reviewId: string, version: number): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM pipeline_steps WHERE state = 'awaiting-human' AND review_id = ? AND review_version = ? LIMIT 1",
        )
        .get(reviewId, version),
    );
  }

  isRunInProgress(runId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM pipeline_runs WHERE id = ? AND status IN (${IN_PROGRESS_SQL})`,
        )
        .get(runId),
    );
  }

  beginStep(
    stepId: string,
    expectedRevision: number,
    startedAt: string,
  ): PipelineStepRecord | undefined {
    if (this.database.isTransaction)
      throw new Error('A step must be recorded as running in its own transaction.');
    return this.transact(() => {
      const current = this.getStep(stepId);
      if (
        !current ||
        current.revision !== expectedRevision ||
        current.state !== 'pending'
      )
        return undefined;
      const run = this.getRun(current.runId);
      if (!run || FINISHED_STATUSES.includes(run.status)) return undefined;
      const running: PipelineStepRecord = {
        ...current,
        revision: current.revision + 1,
        state: 'running',
        attempt: Math.max(current.attempt, 1),
        startedAt,
        updatedAt: startedAt,
      };
      return this.replaceStep(running, expectedRevision) ? running : undefined;
    });
  }

  prune(projectRoot: string, keep = PIPELINE_RUN_RETENTION): void {
    this.transact(() =>
      this.database
        .prepare(
          `DELETE FROM pipeline_runs WHERE project_root = ? AND status IN (${FINISHED_SQL}) AND id NOT IN (SELECT id FROM pipeline_runs WHERE project_root = ? AND status IN (${FINISHED_SQL}) ORDER BY created_at DESC, id DESC LIMIT ?)`,
        )
        .run(projectRoot, projectRoot, keep),
    );
  }

  interruptActiveRuns(at: string): void {
    this.transact(() => {
      const uncertainRunIds = this.database
        .prepare(
          "SELECT DISTINCT run_id FROM pipeline_steps WHERE state = 'running' AND type = 'action'",
        )
        .all()
        .map(row => String(row.run_id));
      this.database
        .prepare(
          "UPDATE pipeline_steps SET document = json_set(document, '$.state', CASE WHEN type = 'action' THEN 'uncertain' ELSE 'interrupted' END, '$.revision', revision + 1, '$.updatedAt', ?), state = CASE WHEN type = 'action' THEN 'uncertain' ELSE 'interrupted' END, revision = revision + 1, updated_at = ? WHERE state = 'running'",
        )
        .run(at, at);
      const interrupt = this.database.prepare(
        `UPDATE pipeline_runs SET document = json_set(document, '$.status', 'interrupted', '$.revision', revision + 1, '$.updatedAt', ?), status = 'interrupted', revision = revision + 1, updated_at = ? WHERE status IN (${RUNNING_SQL}) AND id NOT IN (SELECT value FROM json_each(?))`,
      );
      interrupt.run(at, at, JSON.stringify(uncertainRunIds));
      this.database
        .prepare(
          `UPDATE pipeline_runs SET document = json_set(document, '$.status', 'needs-attention', '$.attention', ?, '$.revision', revision + 1, '$.updatedAt', ?), status = 'needs-attention', revision = revision + 1, updated_at = ? WHERE status IN (${RECOVERABLE_SQL}) AND id IN (SELECT value FROM json_each(?))`,
        )
        .run(EXTERNAL_ACTION_ATTENTION, at, at, JSON.stringify(uncertainRunIds));
    });
  }

  unfinishedRunIds(): string[] {
    return this.database
      .prepare(
        `SELECT id FROM pipeline_runs WHERE status NOT IN (${TERMINAL_SQL}) ORDER BY created_at, id`,
      )
      .all()
      .map(row => String(row.id));
  }

  linkSession(
    sessionId: string,
    runId: string | null,
    stepId: string | null,
  ): boolean {
    return this.transact(
      () =>
        Number(
          this.database
            .prepare(
              "UPDATE sessions SET document = json_set(document, '$.pipelineRunId', ?, '$.pipelineStepId', ?), pipeline_run_id = (SELECT id FROM pipeline_runs WHERE id = ?), pipeline_step_id = (SELECT id FROM pipeline_steps WHERE id = ?) WHERE id = ?",
            )
            .run(runId, stepId, runId, stepId, sessionId).changes,
        ) === 1,
    );
  }
}
