CREATE TABLE IF NOT EXISTS page_copy (
  url TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
