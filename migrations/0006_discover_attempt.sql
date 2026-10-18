CREATE TABLE IF NOT EXISTS discover_attempt (
  system_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (system_id, url)
);
