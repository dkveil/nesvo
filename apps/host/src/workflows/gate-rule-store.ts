import type { DatabaseSync } from 'node:sqlite';
import {
  metadataRevision,
  saveVersionedMetadata,
} from './assistant-change-store';
import {
  gateRuleGenerationSchema,
  gateRuleLimits,
  gateRuleProposalSchema,
  type DecideGateRuleInput,
  type GateRuleGeneration,
  type GateRuleProposal,
} from '@nesvo/contracts';

export const installGateRuleTables = (database: DatabaseSync) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gate_rule_generations (
      run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK (json_valid(document))
    );
    CREATE TABLE IF NOT EXISTS gate_rule_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES gate_rule_generations(run_id) ON DELETE CASCADE,
      document TEXT NOT NULL CHECK (json_valid(document)),
      source_step TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gate_rule_proposals_run ON gate_rule_proposals (run_id);
    CREATE INDEX IF NOT EXISTS gate_rule_proposals_pending ON gate_rule_proposals (id)
      WHERE json_extract(document, '$.status') IN ('pending', 'stale');
    CREATE TABLE IF NOT EXISTS gate_rule_receipts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES gate_rule_generations(run_id) ON DELETE CASCADE,
      payload TEXT NOT NULL CHECK (json_valid(payload))
    );
  `);
};

export class GateRuleStore {
  constructor(private readonly database: DatabaseSync) {}

  enabled(): boolean {
    return (
      this.database
        .prepare("SELECT value FROM metadata WHERE key = 'gate-rule-enabled'")
        .get()?.value !== 'false'
    );
  }

  setEnabled(enabled: boolean): void {
    saveVersionedMetadata(this.database, 'gate-rule-enabled', String(enabled));
  }

  enabledRevision(): number {
    return metadataRevision(this.database, 'gate-rule-enabled');
  }

  claimNumber(minimum: number): number {
    const row = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'gate-rule-next'")
      .get();
    const number = Math.max(minimum, Number(row?.value ?? 1));
    this.metadata('gate-rule-next', String(number + 1));
    return number;
  }

  start(runId: string): GateRuleGeneration | null {
    const generation: GateRuleGeneration = {
      runId,
      sessionId: null,
      status: 'running',
      reason: null,
      retries: 0,
    };
    const result = this.database
      .prepare(
        'INSERT OR IGNORE INTO gate_rule_generations (run_id, document) VALUES (?, ?)',
      )
      .run(runId, JSON.stringify(generation));
    return result.changes ? generation : null;
  }

  recover(): void {
    this.database
      .prepare(
        `
      UPDATE gate_rule_generations
      SET document = json_set(document, '$.status', 'interrupted', '$.reason', 'The host stopped before proposals finished.')
      WHERE json_extract(document, '$.status') = 'running'
    `,
      )
      .run();
  }

  generation(runId: string): GateRuleGeneration | null {
    const row = this.database
      .prepare('SELECT document FROM gate_rule_generations WHERE run_id = ?')
      .get(runId);
    return row
      ? gateRuleGenerationSchema.parse(JSON.parse(String(row.document)))
      : null;
  }

  saveGeneration(generation: GateRuleGeneration): void {
    this.database
      .prepare('UPDATE gate_rule_generations SET document = ? WHERE run_id = ?')
      .run(JSON.stringify(generation), generation.runId);
  }

  pendingCount(): number {
    return Number(
      this.database
        .prepare(
          `
      SELECT count(*) AS count FROM gate_rule_proposals
      WHERE json_extract(document, '$.status') IN ('pending', 'stale')
    `,
        )
        .get()?.count,
    );
  }

  proposals(runId?: string): GateRuleProposal[] {
    const rows = runId
      ? this.database
          .prepare(
            'SELECT document FROM gate_rule_proposals WHERE run_id = ? ORDER BY rowid',
          )
          .all(runId)
      : this.database
          .prepare(
            `
          SELECT document FROM gate_rule_proposals
          WHERE json_extract(document, '$.status') IN ('pending', 'stale')
          ORDER BY rowid DESC LIMIT ?
        `,
          )
          .all(gateRuleLimits.pending);
    return rows.map(row =>
      gateRuleProposalSchema.parse(JSON.parse(String(row.document))),
    );
  }

  proposal(id: string): { row: GateRuleProposal; sourceStep: string } | null {
    const record = this.database
      .prepare(
        'SELECT document, source_step FROM gate_rule_proposals WHERE id = ?',
      )
      .get(id);
    return record
      ? {
          row: gateRuleProposalSchema.parse(
            JSON.parse(String(record.document)),
          ),
          sourceStep: String(record.source_step),
        }
      : null;
  }

  complete(
    generation: GateRuleGeneration,
    proposals: readonly {
      row: GateRuleProposal;
      sourceStep: string;
    }[],
  ): void {
    this.transact(() => {
      this.saveGeneration(generation);
      const insert = this.database.prepare(
        'INSERT INTO gate_rule_proposals (id, run_id, document, source_step) VALUES (?, ?, ?, ?)',
      );
      for (const { row, sourceStep } of proposals)
        insert.run(row.id, row.runId, JSON.stringify(row), sourceStep);
    });
  }

  receipt(id: string): string | null {
    const row = this.database
      .prepare('SELECT payload FROM gate_rule_receipts WHERE id = ?')
      .get(id);
    return row ? String(row.payload) : null;
  }

  decide(row: GateRuleProposal, input: DecideGateRuleInput): void {
    this.transact(() => {
      this.saveReceipt(input.decisionId, row.runId, input);
      this.database
        .prepare('UPDATE gate_rule_proposals SET document = ? WHERE id = ?')
        .run(JSON.stringify(row), row.id);
    });
  }

  retry(generation: GateRuleGeneration, requestId: string): void {
    this.transact(() => {
      this.saveReceipt(requestId, generation.runId, {
        runId: generation.runId,
      });
      this.saveGeneration(generation);
    });
  }

  private saveReceipt(id: string, runId: string, payload: object): void {
    this.database
      .prepare(
        'INSERT INTO gate_rule_receipts (id, run_id, payload) VALUES (?, ?, ?)',
      )
      .run(id, runId, JSON.stringify(payload));
  }

  private metadata(key: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private transact(work: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
