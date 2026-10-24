CREATE TABLE IF NOT EXISTS page_work (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_crawled TEXT,
  last_indexed TEXT,
  claimed_at TEXT,
  error TEXT,
  item_key TEXT,
  PRIMARY KEY (system_id, url)
);
