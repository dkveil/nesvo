ALTER TABLE workflow_launches ADD COLUMN prepared_spec TEXT;
ALTER TABLE workflow_launches ADD COLUMN prepared_at INTEGER;
ALTER TABLE workflow_launches ADD COLUMN derived_worktree INTEGER;
ALTER TABLE workflow_launches ADD COLUMN quota_hold_reason TEXT;
