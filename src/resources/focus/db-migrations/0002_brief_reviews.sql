-- User feedback on brief items (check = complete, x = irrelevant + why).
-- Written by the Home app via /api/db/write; read by the Daily Brief
-- Generator as a hard input so dismissed items (and their siblings) are not
-- resurfaced, and by Sleep to promote standing rules into MEMORY.md.
-- Every synced table needs a PRIMARY KEY for Turso replica sync.
CREATE TABLE IF NOT EXISTS brief_reviews (
  item_key TEXT PRIMARY KEY,
  brief_date TEXT NOT NULL,
  section TEXT NOT NULL,
  item_type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'irrelevant')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS brief_reviews_by_date ON brief_reviews (brief_date);
