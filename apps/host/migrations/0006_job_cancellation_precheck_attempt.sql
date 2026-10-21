ALTER TABLE harness_job_cancellations ADD COLUMN precheck_attempt_id TEXT REFERENCES harness_job_attempts(id);
