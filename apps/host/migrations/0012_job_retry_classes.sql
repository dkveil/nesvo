PRAGMA defer_foreign_keys=ON;

CREATE TEMP TABLE harness_job_retries_copy AS SELECT * FROM harness_job_retries ORDER BY rowid;

DROP TABLE harness_job_retries;

CREATE TABLE harness_job_retries (
  source_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
  occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
  native_attempt_id TEXT REFERENCES workflow_attempts(id),
  receipt_id TEXT REFERENCES operation_receipts(id),
  decided_at INTEGER NOT NULL CHECK(decided_at>=0),
  not_before INTEGER NOT NULL CHECK(not_before>=decided_at),
  next_ordinal INTEGER CHECK(next_ordinal BETWEEN 2 AND 8),
  state TEXT NOT NULL CHECK(state IN ('waiting','claimed','canceled','blocked','adopted')),
  claimed_at INTEGER CHECK(claimed_at>=0),
  target_attempt_id TEXT UNIQUE REFERENCES harness_job_attempts(id),
  class TEXT NOT NULL DEFAULT 'noEffect' CHECK(class IN ('noEffect','uncertainEffect','definiteEffect')),
  failure TEXT,
  launch_key TEXT,
  probe TEXT CHECK(probe IS NULL OR json_valid(probe)),
  claim_probe TEXT CHECK(claim_probe IS NULL OR json_valid(claim_probe)),
  CHECK(class<>'noEffect' OR (native_attempt_id IS NOT NULL AND receipt_id IS NOT NULL AND next_ordinal IS NOT NULL)),
  CHECK(class='noEffect' OR (failure IS NOT NULL AND launch_key IS NOT NULL)),
  CHECK(state<>'adopted' OR (class='definiteEffect' AND native_attempt_id IS NOT NULL AND probe IS NOT NULL))
);

INSERT INTO harness_job_retries(source_attempt_id,occurrence_id,native_attempt_id,receipt_id,decided_at,not_before,next_ordinal,state,claimed_at,target_attempt_id) SELECT source_attempt_id,occurrence_id,native_attempt_id,receipt_id,decided_at,not_before,next_ordinal,state,claimed_at,target_attempt_id FROM temp.harness_job_retries_copy ORDER BY rowid;

DROP TABLE temp.harness_job_retries_copy;

CREATE INDEX harness_job_retries_due ON harness_job_retries(state,not_before);
