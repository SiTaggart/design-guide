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

CREATE TABLE IF NOT EXISTS discover_run (
  system_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  job_id TEXT NOT NULL,
  start_url TEXT NOT NULL,
  state TEXT NOT NULL,
  cursor TEXT,
  poll_failures INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discover_url (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);

CREATE TABLE IF NOT EXISTS system_mark (
  system_id TEXT PRIMARY KEY,
  last_discovered TEXT
);
