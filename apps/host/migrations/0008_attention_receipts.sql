CREATE TABLE attention_receipts (
  item_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  acknowledged_at INTEGER NOT NULL
);
