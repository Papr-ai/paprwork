-- Goals + tasks projection. Markdown stays canonical:
--   goals   ← IDENTITY.md ## Goals  +  workspace/goals/archive.md
--   tasks   ← L3 goal blocks  +  entity page ## Open Items checkboxes
-- The gateway re-projects after Sleep / Wiki Writer complete and on boot
-- (goalsTasksProjection.ts). Rows are upserted by stable id; goal_history
-- gets a row whenever status/confidence/priority/parent changes so the
-- quarter-by-quarter record is queryable. Every table has a PRIMARY KEY
-- for Turso replica sync.

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,               -- G-number, never renumbered
  title TEXT NOT NULL,
  level TEXT NOT NULL,               -- L1 | L2 | L3
  parent_id TEXT,                    -- G-number of the level above (NULL for L1)
  status TEXT NOT NULL,              -- proposed | on-track | at-risk | blocked | done | dropped | unknown
  confidence TEXT NOT NULL,          -- high | medium | low | unknown
  priority INTEGER NOT NULL DEFAULT 99,
  period TEXT,                       -- 2026-Q3 | 2026
  opened TEXT,                       -- YYYY-MM-DD
  closed TEXT,                       -- YYYY-MM-DD when done/dropped
  next_milestone TEXT,
  owner TEXT,
  evidence TEXT,
  mentions INTEGER,
  outcome TEXT,                      -- one line, set when closed
  archived INTEGER NOT NULL DEFAULT 0, -- 1 when the block lives in goals/archive.md
  parent_missing INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL,         -- IDENTITY.md | goals/archive.md
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS goals_by_level ON goals (level, priority);
CREATE INDEX IF NOT EXISTS goals_by_period ON goals (period);
CREATE INDEX IF NOT EXISTS goals_by_parent ON goals (parent_id);

CREATE TABLE IF NOT EXISTS goal_history (
  id TEXT PRIMARY KEY,               -- <goal_id>:<changed_at>
  goal_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  field TEXT NOT NULL,               -- status | confidence | priority | parent_id | period | archived | title
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS goal_history_by_goal ON goal_history (goal_id, changed_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,               -- 'goal:G7' for L3 blocks | 'item:<sha1(entity_ref|normalized title)>' for Open Items
  title TEXT NOT NULL,
  status TEXT NOT NULL,              -- open | done | dropped
  owner TEXT NOT NULL,               -- user | agent | papr | config | unknown
  due TEXT,                          -- YYYY-MM-DD when parseable
  goal_id TEXT,                      -- G-number this task advances (L2 for L3 blocks; from "(G2)" tag on open items)
  entity_ref TEXT,                   -- e.g. people/justin-jones | projects/home
  source TEXT NOT NULL,              -- l3-goal | open-item
  source_file TEXT NOT NULL,         -- workspace-relative path
  source_line INTEGER,               -- 0-based checkbox index within the Open Items section (write-back handle)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks (status, due);
CREATE INDEX IF NOT EXISTS tasks_by_goal ON tasks (goal_id);
CREATE INDEX IF NOT EXISTS tasks_by_entity ON tasks (entity_ref);

-- Brief items can point at the task they represent so a check in Home completes the task.
ALTER TABLE brief_reviews ADD COLUMN task_id TEXT;
