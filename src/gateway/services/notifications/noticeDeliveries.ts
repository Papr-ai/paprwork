/**
 * Deliveries: one row per time a notice went (or was held back) on a channel.
 * Today the only channel is "os" (macOS / Windows / Linux notification). The why
 * from route() is kept on every row, so "why did I get this?" always has an answer.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const DELIVERIES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    notice_id TEXT NOT NULL,
    notice_key TEXT NOT NULL,
    source_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    why TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_source ON deliveries(channel, source_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_deliveries_notice ON deliveries(notice_id);
`;

/** No source pops the OS more than this many times in the window; the rest stay as dots. */
export const OS_CAP_PER_SOURCE = 5;
export const OS_CAP_WINDOW_MS = 10 * 60 * 1000;

export type DeliveryStatus = "sent" | "capped";

export interface DeliveryRecord {
  noticeId: string;
  noticeKey: string;
  sourceId: string;
  channel: "os";
  status: DeliveryStatus;
  why: string[];
}

export class DeliveryLog {
  constructor(private db: Database.Database) {
    db.exec(DELIVERIES_SCHEMA);
  }

  /** OS pops this source sent recently (capped ones don't count). */
  recentSent(sourceId: string, now = Date.now()): number {
    const since = new Date(now - OS_CAP_WINDOW_MS).toISOString();
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE channel='os' AND status='sent' AND source_id=? AND created_at >= ?")
      .get(sourceId, since) as { n: number };
    return row.n;
  }

  record(d: DeliveryRecord): void {
    this.db
      .prepare(`INSERT INTO deliveries (id, notice_id, notice_key, source_id, channel, status, why, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), d.noticeId, d.noticeKey, d.sourceId, d.channel, d.status, JSON.stringify(d.why), new Date().toISOString());
  }

  forNotice(noticeId: string): { channel: string; status: string; why: string[]; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT channel, status, why, created_at FROM deliveries WHERE notice_id=? ORDER BY created_at")
      .all(noticeId) as { channel: string; status: string; why: string; created_at: string }[];
    return rows.map((r) => ({ channel: r.channel, status: r.status, why: JSON.parse(r.why) as string[], createdAt: r.created_at }));
  }

  /** Drop delivery history older than the notice history we keep. */
  prune(olderThanIso: string): void {
    this.db.prepare("DELETE FROM deliveries WHERE created_at < ?").run(olderThanIso);
  }
}
