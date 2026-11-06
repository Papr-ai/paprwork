/**
 * Measure (Stage 1c): how much reaches you, per day and source, kept next to the notices table.
 * Counts only, never titles or content. "Time to done" is read from the notices themselves.
 *   raised  a new notice (a repeat of an open one isn't counted again)
 *   os      a desktop notification shown;  capped  held back by the 5-per-10-minutes limit
 *   paused  held back by Do Not Disturb;   muted   dropped by your settings;  mute  you turned something off
 *   later   you pressed Later in Focus;     mute1h  you muted a source for an hour from Focus
 */
import type Database from "better-sqlite3";

export const STATS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notice_counts (
    day TEXT NOT NULL,
    source_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, source_id, metric)
  );
`;

export type Metric = "raised" | "os" | "capped" | "paused" | "muted" | "mute" | "later" | "mute1h";
export const METRICS: Metric[] = ["raised", "os", "capped", "paused", "muted", "mute", "later", "mute1h"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar day, so "today" matches the person's day. */
export function dayOf(t = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface NoticeStats {
  days: number;
  totals: Record<Metric, number>;
  /** Notices raised per day, averaged over the days in the window. */
  perDay: number;
  bySource: { source: string; raised: number; os: number }[];
  /** Median minutes from raised to done, for notices that were done in the window. */
  medianMinutesToDone: number | null;
}

export class StatsLog {
  constructor(private db: Database.Database) {
    db.exec(STATS_SCHEMA);
  }

  bump(sourceId: string, metric: Metric, by = 1, now = Date.now()): void {
    if (by <= 0) return;
    this.db.prepare(`INSERT INTO notice_counts (day, source_id, metric, n) VALUES (?, ?, ?, ?)
      ON CONFLICT(day, source_id, metric) DO UPDATE SET n = n + excluded.n`).run(dayOf(now), sourceId, metric, by);
  }

  summary(days = 7, now = Date.now()): NoticeStats {
    const since = dayOf(now - (days - 1) * DAY_MS);
    const rows = this.db.prepare("SELECT source_id, metric, SUM(n) AS n FROM notice_counts WHERE day >= ? GROUP BY source_id, metric")
      .all(since) as { source_id: string; metric: Metric; n: number }[];
    const totals = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
    const src = new Map<string, { raised: number; os: number }>();
    for (const r of rows) {
      if (r.metric in totals) totals[r.metric] += r.n;
      if (r.metric !== "raised" && r.metric !== "os") continue;
      const s = src.get(r.source_id) ?? { raised: 0, os: 0 };
      s[r.metric] += r.n;
      src.set(r.source_id, s);
    }
    const sinceIso = new Date(now - days * DAY_MS).toISOString();
    const spans = (this.db.prepare(`SELECT (julianday(resolved_at) - julianday(created_at)) * 1440 AS m FROM notices
      WHERE resolved_at IS NOT NULL AND resolved_at >= ? ORDER BY m`).all(sinceIso) as { m: number }[]).map((r) => r.m);
    const mid = spans.length ? spans[Math.floor((spans.length - 1) / 2)] : null;
    return {
      days, totals, perDay: Math.round((totals.raised / days) * 10) / 10,
      bySource: [...src.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.raised - a.raised),
      medianMinutesToDone: mid === null ? null : Math.round(mid),
    };
  }

  prune(olderThanDays = 90, now = Date.now()): void {
    this.db.prepare("DELETE FROM notice_counts WHERE day < ?").run(dayOf(now - olderThanDays * DAY_MS));
  }
}

/** How many things a settings change turns off (each false in the patch). */
export function countOffs(patch: unknown): number {
  if (patch === false) return 1;
  if (!patch || typeof patch !== "object") return 0;
  return Object.entries(patch as Record<string, unknown>).reduce((n, [k, v]) => n + (k === "pauseUntil" || k === "muteUntil" ? 0 : countOffs(v)), 0);
}
