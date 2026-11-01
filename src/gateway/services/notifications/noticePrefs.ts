/**
 * Your notification settings, saved next to the notices table. Anything you haven't
 * changed falls back to DEFAULT_NOTICE_PREFS, so improving a default reaches everyone
 * who never touched it, and "Reset to defaults" just deletes your overrides.
 */
import type Database from "better-sqlite3";
import { DEFAULT_NOTICE_PREFS, type AppPref, type NoticePrefs } from "../../../core/notifications/route.js";

export const PREFS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notice_prefs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const APP_PREFS = new Set<AppPref>(["all", "mentions", "off"]);

/** Only known fields with the right types survive; a bad write can't break routing. */
export function cleanPrefs(raw: unknown): Partial<NoticePrefs> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<NoticePrefs> = {};
  for (const k of ["priorityOs", "priorityEmail", "chatDoneOs"] as const) {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  }
  if (r.apps && typeof r.apps === "object") {
    const apps: Record<string, AppPref> = {};
    for (const [id, v] of Object.entries(r.apps as Record<string, unknown>)) {
      if (id && APP_PREFS.has(v as AppPref)) apps[id] = v as AppPref;
    }
    out.apps = apps;
  }
  return out;
}

export class PrefsStore {
  constructor(private db: Database.Database) {
    db.exec(PREFS_SCHEMA);
  }

  /** Just what you changed. */
  overrides(): Partial<NoticePrefs> {
    const row = this.db.prepare("SELECT json FROM notice_prefs WHERE id=1").get() as { json: string } | undefined;
    if (!row) return {};
    try { return cleanPrefs(JSON.parse(row.json)); } catch { return {}; }
  }

  /** Defaults with your changes on top. */
  effective(): NoticePrefs {
    return { ...DEFAULT_NOTICE_PREFS, ...this.overrides() };
  }

  /** Merge a change. A value equal to the default is dropped, so it follows future defaults. */
  set(patch: unknown): NoticePrefs {
    const next: Partial<NoticePrefs> = { ...this.overrides(), ...cleanPrefs(patch) };
    for (const k of ["priorityOs", "priorityEmail", "chatDoneOs"] as const) {
      if (next[k] === DEFAULT_NOTICE_PREFS[k]) delete next[k];
    }
    if (next.apps) {
      // "For me" is the app default: only keep apps you moved off it.
      next.apps = Object.fromEntries(Object.entries(next.apps).filter(([, v]) => v !== "mentions"));
      if (!Object.keys(next.apps).length) delete next.apps;
    }
    if (!Object.keys(next).length) this.reset();
    else {
      this.db.prepare(`INSERT INTO notice_prefs (id, json, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
        .run(JSON.stringify(next), new Date().toISOString());
    }
    return this.effective();
  }

  reset(): NoticePrefs {
    this.db.prepare("DELETE FROM notice_prefs").run();
    return this.effective();
  }
}
