CREATE TABLE session_hibernations (
  session_id TEXT PRIMARY KEY CHECK(length(session_id)=32 AND session_id NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('stopping','hibernated','resuming')),
  record TEXT NOT NULL CHECK(json_valid(record)),
  operation_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);

CREATE TABLE session_hibernation_keys (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('hibernate','resume')),
  session_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('pending','done')),
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  CHECK(phase!='done' OR result IS NOT NULL)
);

CREATE INDEX session_hibernation_keys_age ON session_hibernation_keys(created_at,key);
