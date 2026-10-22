use anyhow::Result;
use rusqlite::Connection;

pub fn initialize_legacy_schema(connection: &Connection) -> Result<()> {
    crate::migrations::ensure_pre_ledger(connection)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS harness_job_retries(
            source_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
            occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
            native_attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),
            receipt_id TEXT NOT NULL REFERENCES operation_receipts(id),
            decided_at INTEGER NOT NULL CHECK(decided_at>=0),
            not_before INTEGER NOT NULL CHECK(not_before>=decided_at),
            next_ordinal INTEGER NOT NULL CHECK(next_ordinal BETWEEN 2 AND 8),
            state TEXT NOT NULL CHECK(state IN ('waiting','claimed','canceled','blocked')),
            claimed_at INTEGER CHECK(claimed_at>=0),
            target_attempt_id TEXT UNIQUE REFERENCES harness_job_attempts(id)
        );
        CREATE INDEX IF NOT EXISTS harness_job_retries_due
            ON harness_job_retries(state,not_before);",
    )?;
    Ok(())
}
