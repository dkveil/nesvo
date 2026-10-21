ALTER TABLE harness_job_occurrences ADD COLUMN current_job_attempt_id TEXT REFERENCES harness_job_attempts(id);
