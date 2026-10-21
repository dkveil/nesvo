ALTER TABLE workflow_wake_policies ADD COLUMN delivery TEXT NOT NULL DEFAULT 'delta' CHECK(delivery IN('delta','full'));
ALTER TABLE workflow_wake_policies ADD COLUMN held INTEGER NOT NULL DEFAULT 0 CHECK(held IN(0,1));
ALTER TABLE workflow_wake_batches ADD COLUMN delivery TEXT;
ALTER TABLE workflow_wake_batches ADD COLUMN after_sequence INTEGER;
ALTER TABLE workflow_wake_batches ADD COLUMN baseline TEXT;
