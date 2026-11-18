CREATE TABLE shares (
  id TEXT PRIMARY KEY NOT NULL,
  bundle TEXT NOT NULL,
  revoke_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX shares_expires_at ON shares (expires_at);

CREATE TABLE share_rate_limits (
  client_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (client_key, window_start)
);

CREATE INDEX share_rate_limits_window_start ON share_rate_limits (window_start);

CREATE TABLE release_cache (
  repository TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
