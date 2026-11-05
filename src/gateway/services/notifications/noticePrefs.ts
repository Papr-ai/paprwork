/**
 * Your notification settings, saved next to the notices table. Only what you changed is stored
 * (see core/notifications/prefs.ts); anything else follows the defaults as they improve, and
 * "Reset to defaults" just deletes the row. Stage 1 settings are carried over on first read.
 */
import type Database from "better-sqlite3";
import { DEFAULT_NOTICE_PREFS, cleanPrefs, mergePrefs, type NoticePrefs } from "../../../core/notifications/prefs.js";

export const PREFS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notice_prefs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export class PrefsStore {
  constructor(private db: Database.Database) {
    db.exec(PREFS_SCHEMA);
  }

  /** Your changes on top of the defaults (stored sparse, so this is also "just what you changed"). */
  effective(): NoticePrefs {
    const row = this.db.prepare("SELECT json FROM notice_prefs WHERE id=1").get() as { json: string } | undefined;
    if (!row) return DEFAULT_NOTICE_PREFS;
    let raw: unknown;
    try { raw = JSON.parse(row.json); } catch { return DEFAULT_NOTICE_PREFS; }
    const prefs = cleanPrefs(raw);
    // Stage 1 shape: save the carried-over version so it's done once.
    if ((raw as { version?: unknown })?.version !== 2) this.write(prefs);
    return prefs;
  }

  set(patch: unknown): NoticePrefs {
    return this.write(mergePrefs(this.effective(), patch));
  }

  reset(): NoticePrefs {
    this.db.prepare("DELETE FROM notice_prefs").run();
    return DEFAULT_NOTICE_PREFS;
  }

  private write(p: NoticePrefs): NoticePrefs {
    if (!Object.keys(p.sources).length && !Object.keys(p.types).length && !p.pauseUntil && !p.previews) return this.reset();
    this.db.prepare(`INSERT INTO notice_prefs (id, json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
      .run(JSON.stringify(p), new Date().toISOString());
    return p;
  }
}
