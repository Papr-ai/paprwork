-- Home daily briefs registry database.
-- Copied to data/databases/home-daily-briefs/migrations/0001_init.sql on install.
-- Every synced table needs a PRIMARY KEY for Turso replica sync + row versioning.
CREATE TABLE IF NOT EXISTS briefs (
  date TEXT PRIMARY KEY,
  brief_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
