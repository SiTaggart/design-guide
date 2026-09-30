CREATE TABLE IF NOT EXISTS seed_refresh (
  system_id TEXT PRIMARY KEY,
  seed_hash TEXT NOT NULL,
  enqueued_at TEXT NOT NULL
);
