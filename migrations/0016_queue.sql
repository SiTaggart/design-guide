CREATE TABLE IF NOT EXISTS queue (
  url TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  error TEXT,
  op TEXT NOT NULL DEFAULT 'fetch'
);

CREATE INDEX IF NOT EXISTS queue_enqueued_at ON queue (enqueued_at, url);

ALTER TABLE system_mark ADD COLUMN refresh_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE system_mark ADD COLUMN refresh_after TEXT;
