PRAGMA defer_foreign_keys=ON;

CREATE TABLE IF NOT EXISTS operation_receipts (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  operation TEXT NOT NULL,
  phase TEXT NOT NULL,
  session_id TEXT NOT NULL,
  result TEXT NOT NULL,
  claim_token TEXT,
  UNIQUE(issuer,key)
);

CREATE TEMP TABLE workflow_process_exits_copy AS SELECT session_id,observed_at FROM workflow_process_exits ORDER BY rowid;

DROP TABLE workflow_process_exits;

CREATE TABLE workflow_process_exits (
  session_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL
);

INSERT INTO workflow_process_exits(session_id,observed_at) SELECT session_id,observed_at FROM temp.workflow_process_exits_copy ORDER BY rowid;

DROP TABLE temp.workflow_process_exits_copy;

CREATE TEMP TABLE harness_job_timeouts_copy AS SELECT * FROM harness_job_timeouts ORDER BY rowid;

DROP TABLE harness_job_timeouts;

CREATE TABLE harness_job_timeouts (
  job_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
  job_id TEXT NOT NULL REFERENCES harness_jobs(id),
  occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(id),
  session_id TEXT NOT NULL UNIQUE,
  launch_receipt_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),
  issuer TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1000 AND 604800000),
  armed_at INTEGER NOT NULL CHECK(armed_at>=0),
  deadline_at INTEGER NOT NULL CHECK(deadline_at>armed_at),
  armed_monotonic_ms INTEGER NOT NULL CHECK(armed_monotonic_ms>=0),
  deadline_monotonic_ms INTEGER NOT NULL CHECK(deadline_monotonic_ms>armed_monotonic_ms),
  state TEXT NOT NULL CHECK(state IN ('armed','disarmed','dispatching','awaitingExit','blocked','unconfirmed','completed')),
  requested_at INTEGER,
  observed_at INTEGER NOT NULL,
  reason TEXT,
  control_key TEXT NOT NULL UNIQUE,
  control_id TEXT REFERENCES workflow_controls(id),
  token TEXT
);

INSERT INTO harness_job_timeouts SELECT * FROM temp.harness_job_timeouts_copy ORDER BY rowid;

DROP TABLE temp.harness_job_timeouts_copy;

CREATE INDEX harness_job_timeouts_due ON harness_job_timeouts(state,deadline_monotonic_ms);

CREATE INDEX harness_job_timeouts_control ON harness_job_timeouts(control_id) WHERE control_id IS NOT NULL;

CREATE TEMP TABLE workflow_attempts_copy AS SELECT id,task_id,ordinal,session_id,state,result,validation FROM workflow_attempts ORDER BY rowid;

DROP TABLE workflow_attempts;

CREATE TABLE workflow_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES workflow_tasks(id),
  ordinal INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  validation TEXT,
  UNIQUE(task_id,ordinal)
);

INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state,result,validation) SELECT id,task_id,ordinal,session_id,state,result,validation FROM temp.workflow_attempts_copy ORDER BY rowid;

DROP TABLE temp.workflow_attempts_copy;

CREATE INDEX workflow_attempts_session ON workflow_attempts(session_id,ordinal);

CREATE UNIQUE INDEX workflow_attempts_open_session ON workflow_attempts(session_id) WHERE state IN ('launching','launchUnknown','assigned','reported');

CREATE TABLE workflow_session_reuses (
  attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),
  previous_attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(id),
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE workflow_delivery_identities (
  delivery_id TEXT PRIMARY KEY REFERENCES workflow_deliveries(id),
  conversation_id TEXT NOT NULL
);
