CREATE TABLE session_restore_outcomes (
  session_id TEXT PRIMARY KEY CHECK(length(session_id)=32 AND session_id NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('pending','restored','hibernated','reaped')),
  code TEXT CHECK(code IS NULL OR length(code) BETWEEN 1 AND 64),
  message TEXT CHECK(message IS NULL OR length(message)<=1024),
  shutdown_at INTEGER NOT NULL CHECK(shutdown_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  CHECK(outcome IN ('pending','restored') OR code IS NOT NULL)
);
