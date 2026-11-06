-- Goals ↔ entities. A goal names the wiki entities it runs through
-- (IDENTITY.md `- Entities:` line) and entity pages carry `goals: [G3]` in
-- frontmatter; the projection merges both directions here. Tasks on an
-- entity page inherit that page's goal when untagged (tasks.goal_source).

CREATE TABLE IF NOT EXISTS goal_entities (
  id TEXT PRIMARY KEY,               -- <goal_id>|<entity_ref>
  goal_id TEXT NOT NULL,
  entity_ref TEXT NOT NULL,          -- projects/x | people/y | companies/z
  entity_type TEXT NOT NULL,         -- projects | people | companies | …
  source TEXT NOT NULL,              -- goal | entity | both  (which side declared the link)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS goal_entities_by_goal ON goal_entities (goal_id);
CREATE INDEX IF NOT EXISTS goal_entities_by_entity ON goal_entities (entity_ref);

-- How a task got its goal: tag (explicit "(Gn)"), entity (inherited from the
-- page's single goal), parent (L3 block's Parent), or NULL when untraced.
ALTER TABLE tasks ADD COLUMN goal_source TEXT;
