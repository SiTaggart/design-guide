CREATE TABLE IF NOT EXISTS fill_lease (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
