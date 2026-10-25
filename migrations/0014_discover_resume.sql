CREATE TABLE IF NOT EXISTS discover_resume (
  system_id TEXT PRIMARY KEY,
  seed_hash TEXT NOT NULL,
  yielded_at TEXT NOT NULL
);

ALTER TABLE discover_run ADD COLUMN slice_frontier_start INTEGER;
ALTER TABLE discover_run ADD COLUMN slice_accepted INTEGER NOT NULL DEFAULT 0;
