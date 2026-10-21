CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  coordinator_id TEXT,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_runs_coordinator ON workflow_runs(coordinator_id,created_at);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  task_key TEXT NOT NULL,
  spec TEXT NOT NULL,
  UNIQUE(run_id,task_key)
);

CREATE TABLE IF NOT EXISTS workflow_mutations (
  issuer TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  view TEXT NOT NULL,
  PRIMARY KEY(issuer,key)
);

CREATE TABLE IF NOT EXISTS workflow_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES workflow_tasks(id),
  ordinal INTEGER NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  result TEXT,
  validation TEXT,
  UNIQUE(task_id,ordinal)
);

CREATE TABLE IF NOT EXISTS workflow_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  recipient TEXT NOT NULL,
  data TEXT NOT NULL,
  acked_at INTEGER,
  acked_by TEXT
);

CREATE INDEX IF NOT EXISTS workflow_messages_pending ON workflow_messages(run_id,recipient,acked_at,sequence);

CREATE TABLE IF NOT EXISTS workflow_decisions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_decisions_attempt ON workflow_decisions(attempt_id,sequence);

CREATE TABLE IF NOT EXISTS workflow_run_budget (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  limits TEXT NOT NULL,
  started_at INTEGER,
  exhausted_at INTEGER,
  drain_owner INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflow_controls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  kind TEXT NOT NULL,
  issuer TEXT NOT NULL,
  state TEXT NOT NULL,
  token TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_controls_run ON workflow_controls(run_id);

CREATE TABLE IF NOT EXISTS workflow_process_exits (
  session_id TEXT PRIMARY KEY REFERENCES workflow_attempts(session_id),
  observed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_control_targets (
  control_id TEXT NOT NULL REFERENCES workflow_controls(id),
  session_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),
  position INTEGER NOT NULL,
  key TEXT NOT NULL,
  phase TEXT NOT NULL,
  receipt_id TEXT,
  code TEXT,
  PRIMARY KEY(control_id,session_id)
);

CREATE INDEX IF NOT EXISTS workflow_control_target_session ON workflow_control_targets(session_id);

CREATE INDEX IF NOT EXISTS workflow_control_target_page ON workflow_control_targets(control_id,position);

CREATE TABLE IF NOT EXISTS workflow_launches (
  attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),
  operation_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(id),
  issuer TEXT NOT NULL,
  phase TEXT NOT NULL,
  blocker TEXT,
  operation_id TEXT UNIQUE REFERENCES operation_receipts(id),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_executors (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
  spec TEXT NOT NULL,
  issuer TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  reason TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_executor_launches (
  attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),
  executor_id TEXT NOT NULL REFERENCES workflow_executors(id),
  issuer TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  generation INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_executor_retries (
  executor_id TEXT NOT NULL REFERENCES workflow_executors(id),
  attempt_id TEXT NOT NULL REFERENCES workflow_attempts(id),
  not_before INTEGER NOT NULL,
  PRIMARY KEY(executor_id,attempt_id)
);

CREATE TABLE IF NOT EXISTS workflow_wake_policies (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
  coordinator_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  phase TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_wake_signals (
  attempt_id TEXT PRIMARY KEY REFERENCES workflow_attempts(id),
  data TEXT NOT NULL,
  revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_wake_batches (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES workflow_wake_policies(id),
  generation INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operation_receipts(id),
  phase TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_wake_notices (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  batch_id TEXT REFERENCES workflow_wake_batches(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS workflow_wake_pending ON workflow_wake_notices(run_id,batch_id,sequence);

CREATE TABLE IF NOT EXISTS workflow_constraints (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  issuer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id,revision)
);

CREATE TABLE IF NOT EXISTS workflow_context_ack (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  revision INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_native_context (
  operation_id TEXT PRIMARY KEY REFERENCES operation_receipts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  revision INTEGER NOT NULL,
  admitted INTEGER NOT NULL,
  coordinator_generation INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflow_coordinator_bindings (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  coordinator_id TEXT NOT NULL,
  previous_id TEXT,
  directory TEXT NOT NULL,
  group_id TEXT,
  generation INTEGER NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  ordinal INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  source_cursor INTEGER NOT NULL,
  digest TEXT NOT NULL,
  summary TEXT,
  part_count INTEGER NOT NULL,
  UNIQUE(run_id,ordinal)
);

CREATE TABLE IF NOT EXISTS workflow_checkpoint_parts (
  checkpoint_id TEXT NOT NULL REFERENCES workflow_checkpoints(id),
  ordinal INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(checkpoint_id,ordinal)
);

CREATE TABLE IF NOT EXISTS host_budget (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  data TEXT NOT NULL
);

INSERT OR IGNORE INTO host_budget(id, revision, data) VALUES (1, 1, '{"maxSessions":8,"maxWorkers":8,"providers":{"shell":8,"claude":8,"codex":8,"gemini":8}}');

CREATE TABLE IF NOT EXISTS harness_jobs (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  next_due INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_job_mutations (
  issuer TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  view TEXT NOT NULL,
  PRIMARY KEY(issuer,key)
);

CREATE INDEX IF NOT EXISTS harness_jobs_due ON harness_jobs(enabled,next_due);

CREATE TABLE IF NOT EXISTS harness_job_occurrences (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES harness_jobs(id),
  job_revision INTEGER NOT NULL,
  spec TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  run_id TEXT REFERENCES workflow_runs(id),
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE(job_id,trigger_key)
);

CREATE INDEX IF NOT EXISTS harness_job_occurrences_active ON harness_job_occurrences(state,job_id);

CREATE INDEX IF NOT EXISTS harness_job_occurrences_history ON harness_job_occurrences(job_id,created_at);

CREATE TABLE IF NOT EXISTS harness_precheck_approvals (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_precheck_mutations (
  issuer TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  view TEXT NOT NULL,
  PRIMARY KEY(issuer,key)
);

CREATE TABLE IF NOT EXISTS harness_job_prechecks (
  occurrence_id TEXT PRIMARY KEY REFERENCES harness_job_occurrences(id),
  approval_id TEXT NOT NULL,
  approval_digest TEXT,
  spec TEXT,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  observed_at INTEGER
);

CREATE TABLE IF NOT EXISTS harness_job_cancellations (
  occurrence_id TEXT PRIMARY KEY REFERENCES harness_job_occurrences(id),
  issuer TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  reason TEXT,
  control_key TEXT NOT NULL,
  control_id TEXT,
  token TEXT
);

CREATE INDEX IF NOT EXISTS harness_job_cancellations_pending ON harness_job_cancellations(state);

CREATE INDEX IF NOT EXISTS harness_job_occurrences_run ON harness_job_occurrences(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_job_attempts (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 4096),
  run_id TEXT UNIQUE REFERENCES workflow_runs(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  claimed_at INTEGER CHECK(claimed_at>=0),
  finished_at INTEGER CHECK(finished_at>=0),
  state TEXT NOT NULL,
  reason TEXT,
  dispatch_token TEXT,
  UNIQUE(occurrence_id,ordinal)
);

CREATE INDEX IF NOT EXISTS harness_job_attempts_history ON harness_job_attempts(occurrence_id,ordinal);

CREATE TABLE IF NOT EXISTS harness_job_launch_resolutions (
  job_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
  occurrence_id TEXT NOT NULL UNIQUE REFERENCES harness_job_occurrences(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
  identity TEXT NOT NULL,
  digest TEXT NOT NULL,
  issuer TEXT NOT NULL,
  mutation_key TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at>=0)
);

CREATE TABLE IF NOT EXISTS harness_job_timeouts (
  job_attempt_id TEXT PRIMARY KEY REFERENCES harness_job_attempts(id),
  job_id TEXT NOT NULL REFERENCES harness_jobs(id),
  occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES workflow_attempts(session_id),
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

CREATE INDEX IF NOT EXISTS harness_job_timeouts_due ON harness_job_timeouts(state,deadline_monotonic_ms);

CREATE INDEX IF NOT EXISTS harness_job_timeouts_control ON harness_job_timeouts(control_id) WHERE control_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS harness_job_attempts_precheck_membership ON harness_job_attempts(id,occurrence_id,ordinal);

CREATE TABLE IF NOT EXISTS harness_job_generation_prechecks (
  job_attempt_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES harness_job_occurrences(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 2 AND 4096),
  approval_id TEXT NOT NULL,
  approval_digest TEXT,
  approval_revision INTEGER CHECK(approval_revision>0),
  spec TEXT,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  observed_at INTEGER,
  FOREIGN KEY(job_attempt_id,occurrence_id,ordinal) REFERENCES harness_job_attempts(id,occurrence_id,ordinal)
);

CREATE INDEX IF NOT EXISTS harness_job_generation_prechecks_occurrence ON harness_job_generation_prechecks(occurrence_id);

CREATE TABLE IF NOT EXISTS harness_job_retries (
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

CREATE INDEX IF NOT EXISTS harness_job_retries_due ON harness_job_retries(state,not_before);

CREATE TABLE IF NOT EXISTS harness_job_triggers (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES harness_jobs(id),
  spec TEXT NOT NULL,
  authorized_spec_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
  credential_generation INTEGER NOT NULL CHECK(credential_generation>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_job_trigger_credentials (
  trigger_id TEXT NOT NULL REFERENCES harness_job_triggers(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  secret TEXT,
  secret_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY(trigger_id,generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS harness_job_trigger_active_credential ON harness_job_trigger_credentials(trigger_id) WHERE state='active';

CREATE TABLE IF NOT EXISTS harness_job_trigger_mutations (
  issuer TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  view TEXT NOT NULL,
  PRIMARY KEY(issuer,key)
);

CREATE TABLE IF NOT EXISTS harness_job_trigger_deliveries (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL REFERENCES harness_job_triggers(id),
  delivery_id TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  credential_generation INTEGER NOT NULL,
  trigger_revision INTEGER NOT NULL,
  job_id TEXT NOT NULL REFERENCES harness_jobs(id),
  job_revision INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('queued','skipped','ignored')),
  reason TEXT,
  occurrence_id TEXT UNIQUE REFERENCES harness_job_occurrences(id),
  view TEXT NOT NULL,
  UNIQUE(trigger_id,delivery_id),
  UNIQUE(trigger_id,raw_sha256),
  FOREIGN KEY(trigger_id,credential_generation) REFERENCES harness_job_trigger_credentials(trigger_id,generation)
);

CREATE INDEX IF NOT EXISTS harness_job_trigger_delivery_burst ON harness_job_trigger_deliveries(trigger_id,accepted_at);

CREATE TABLE IF NOT EXISTS harness_job_quota_sources (
  source_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>=1),
  context_id TEXT,
  account_fingerprint TEXT,
  expires_elapsed_ms INTEGER NOT NULL CHECK(expires_elapsed_ms>=0),
  eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS harness_job_quota_sources_binding ON harness_job_quota_sources(context_id,account_fingerprint);

CREATE TABLE IF NOT EXISTS harness_job_quota_authorizations (
  occurrence_id TEXT PRIMARY KEY REFERENCES harness_job_occurrences(id),
  context_id TEXT NOT NULL,
  account_fingerprint TEXT NOT NULL,
  paused INTEGER NOT NULL CHECK(paused IN (0,1)),
  authorized_at INTEGER NOT NULL CHECK(authorized_at>=0)
);
