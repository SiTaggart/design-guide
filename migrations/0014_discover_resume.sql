CREATE TABLE IF NOT EXISTS discover_resume (
  system_id TEXT PRIMARY KEY,
  seed_hash TEXT NOT NULL,
  yielded_at TEXT NOT NULL
);
