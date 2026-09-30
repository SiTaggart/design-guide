CREATE TABLE IF NOT EXISTS discover_indexable (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);

CREATE TABLE IF NOT EXISTS recovery_attempt (
  system_id TEXT PRIMARY KEY,
  attempted_at TEXT NOT NULL
);
