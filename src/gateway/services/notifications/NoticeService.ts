/**
 * NoticeService: the local notices table. One row per thing that wants you
 * (a chat finished, a job waiting for a key, ...). Every surface (tab dots,
 * rail icons, later Focus and OS notifications) reads this one table.
 *
 * - notify(): upsert by key. Same key while open = updated in place, count+1.
 * - resolve(key) / resolveGroup(group): the sender clears a condition when it's fixed.
 * - markSeen(owner): looking at the thing clears its events; conditions stay until fixed.
 * Status-level input is never stored: status lives where it happens.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { openDiagnosticDatabase } from "../databaseDiagnostics/sqlite.js";
import { DEFAULT_NOTICE_PREFS, effectiveLevel, route, type NoticePrefs, type RoutedNotice } from "../../../core/notifications/route.js";
import { PAPR_SOURCES, appSourceId, sourceOf } from "../../../core/notifications/sources.js";
import { DeliveryLog, OS_CAP_PER_SOURCE } from "./noticeDeliveries.js";
import { PrefsStore } from "./noticePrefs.js";
import { StatsLog, countOffs } from "./noticeStats.js";
import { pausedAt, previewsOf, type Previews } from "../../../core/notifications/prefs.js";
import {
  NOTICE_MARK,
  type Notice,
  type NoticeInput,
  type NoticeOwnerKind,
} from "../../../core/types/notices.js";
import { NOTICES_SCHEMA, migrateNotices, rowToNotice, type NoticeRow } from "./noticeRows.js";
import { MUTE_MS, laterUntil } from "../../../core/notifications/needsYou.js";

/** Events nobody looked at expire after 14 days; conditions stay until resolved. */
const EVENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Resolved rows are kept a while for history, then dropped. */
const RESOLVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export type NoticesListener = (open: Notice[], prefs: NoticePrefs) => void;
const listeners = new Set<NoticesListener>();

/** Gateway wires this to the WebSocket broadcast. Module-level so it survives workspace switches. */
export function onNoticesChanged(listener: NoticesListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** An OS notification route() decided to send. The UI shows it (it owns the window). */
export interface OsDelivery {
  notice: Notice;
  why: string[];
  /** false: show it silently (done, or the source's Sound is off). */
  sound: boolean;
  /** Show previews setting: the window process hides the text when it says so. */
  previews: Previews;
}
export type OsListener = (d: OsDelivery) => void;
const osListeners = new Set<OsListener>();

export function onNoticeOs(listener: OsListener): () => void {
  osListeners.add(listener);
  return () => osListeners.delete(listener);
}

/** You did something with notices on this device: seen, later, done, or brought back. The cloud sync sends it up. */
export type NoticeMarkState = "seen" | "later" | "done" | "open";
export interface NoticeMarkChange { keys: string[]; state: NoticeMarkState; laterUntil?: string }
type MarkListener = (m: NoticeMarkChange) => void;
const markListeners = new Set<MarkListener>();
export function onNoticeMarked(listener: MarkListener): () => void {
  markListeners.add(listener);
  return () => markListeners.delete(listener);
}
function emitMark(m: NoticeMarkChange): void {
  if (!m.keys.length) return;
  for (const l of markListeners) {
    try { l(m); } catch (e) { console.warn("[NoticeService] mark listener failed:", e); }
  }
}

/** A notice from your server list (another device, a teammate, a proposal). */
export interface RemoteNotice extends NoticeInput {
  state: "open" | "seen" | "later" | "done";
  laterUntil?: string | null;
  updatedAt?: string;
}

export interface ViewedOwner {
  kind: NoticeOwnerKind;
  id: string;
}

/** What's on screen: the active tab (or both halves of a split) and whether the window is in front. */
export interface Viewing {
  owners: ViewedOwner[];
  foreground: boolean;
}

export class NoticeService {
  private db: Database.Database;
  private viewing: Viewing = { owners: [], foreground: true };
  private deliveries: DeliveryLog;
  private prefsStore: PrefsStore;
  private stats: StatsLog;
  /** Defaults with your Settings → Notifications changes on top. */
  prefs: NoticePrefs = DEFAULT_NOTICE_PREFS;

  constructor(dbPath = path.join(getPaprRoot(), "data", "notices.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = openDiagnosticDatabase(Database, "services/NoticeService", dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(NOTICES_SCHEMA);
    migrateNotices(this.db);
    this.deliveries = new DeliveryLog(this.db);
    this.prefsStore = new PrefsStore(this.db);
    this.stats = new StatsLog(this.db);
    this.stats.prune();
    this.prefs = this.prefsStore.effective();
    const cutoff = new Date(Date.now() - RESOLVED_KEEP_MS).toISOString();
    this.db.prepare("DELETE FROM notices WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(cutoff);
    this.deliveries.prune(cutoff);
  }

  /** Raise or update a notice. Returns null when nothing is stored (status, or an FYI on what you're looking at). */
  notify(input: NoticeInput | RoutedNotice, opts: { silent?: boolean } = {}): Notice | null {
    const level = effectiveLevel(input);
    if (level === "status") return null;
    const type = input.type ?? "event";
    if (level === "fyi" && type === "event" && this.isViewing(input.owner.kind, input.owner.id)) return null;

    const now = new Date().toISOString();
    const expiresAt = type === "event" ? new Date(Date.now() + EVENT_TTL_MS).toISOString() : null;
    const values = {
      key: input.key, kind: input.kind, type, level, mark: NOTICE_MARK[level],
      title: input.title, body: input.body ?? null,
      source_type: input.source.type, source_id: input.source.id, source_name: input.source.name,
      owner_kind: input.owner.kind, owner_id: input.owner.id, owner_name: input.owner.name,
      owner_section: input.owner.section ?? null, resolve_group: input.resolveGroup ?? null,
      actions: input.actions?.length ? JSON.stringify(input.actions) : null,
      now, expires_at: expiresAt,
    };
    const existing = this.openByKey(input.key);
    // Decide delivery before writing: an open notice with the same key never pings twice.
    const delivery = route(input, {
      prefs: this.prefs, foreground: this.viewing.foreground, dnd: pausedAt(this.prefs),
      viewingOwner: this.isViewing(input.owner.kind, input.owner.id),
      existing: existing ? { count: existing.count } : undefined,
    });
    if (delivery.muted && !existing) this.stats.bump(delivery.source, "muted");
    if (delivery.level === "status") return null;
    if ((input as RoutedNotice).ambient) values.mark = "none"; // about the whole app: no dot anywhere
    if (!existing) this.stats.bump(delivery.source, "raised");
    if (delivery.paused) this.stats.bump(delivery.source, "paused");
    if (existing) {
      this.db.prepare(`UPDATE notices SET kind=@kind, type=@type, level=@level, mark=@mark, title=@title, body=@body,
        source_type=@source_type, source_id=@source_id, source_name=@source_name, owner_kind=@owner_kind,
        owner_id=@owner_id, owner_name=@owner_name, owner_section=@owner_section, resolve_group=@resolve_group,
        actions=@actions, count=count+1, updated_at=@now, seen_at=NULL, expires_at=@expires_at WHERE id=@id`)
        .run({ ...values, id: existing.id });
    } else {
      this.db.prepare(`INSERT INTO notices (id, key, kind, type, level, mark, title, body, source_type, source_id,
        source_name, owner_kind, owner_id, owner_name, owner_section, resolve_group, actions, count, created_at,
        updated_at, expires_at) VALUES (@id, @key, @kind, @type, @level, @mark, @title, @body, @source_type,
        @source_id, @source_name, @owner_kind, @owner_id, @owner_name, @owner_section, @resolve_group, @actions, 1,
        @now, @now, @expires_at)`).run({ ...values, id: randomUUID() });
    }
    this.changed();
    const stored = this.openByKey(input.key);
    if (stored && delivery.os && !opts.silent) this.deliverOs(stored, delivery.why, delivery.sound, delivery.source);
    return stored;
  }

  /**
   * Apply one notice from the server list. Never echoed back up (no mark listeners).
   * New or refreshed + open: through notify() so route() decides a ping (silent on a first full pull).
   * A chat this desktop opened for it beats the server's generic owner ("People").
   */
  applyRemote(r: RemoteNotice, opts: { silent?: boolean } = {}): boolean {
    const local = this.openByKey(r.key);
    if (r.state === "done") {
      if (!local) return false;
      const now = new Date().toISOString();
      this.db.prepare("UPDATE notices SET resolved_at=?, seen_at=COALESCE(seen_at, ?) WHERE key=? AND resolved_at IS NULL").run(now, now, r.key);
      this.changed();
      return true;
    }
    const owner = local && local.owner.kind === "chat" && r.owner.kind !== "chat" ? local.owner : r.owner;
    const newer = !local || (r.updatedAt ?? "") > local.updatedAt;
    if (newer && (!local || r.state === "open")) this.notify({ ...r, owner }, { silent: opts.silent || !!local });
    const later = r.state === "later" ? r.laterUntil ?? null : null;
    const seen = r.state === "seen" ? new Date().toISOString() : null;
    const res = this.db.prepare(`UPDATE notices SET later_until=@later,
      seen_at=CASE WHEN @seen IS NOT NULL THEN COALESCE(seen_at, @seen) WHEN @open=1 THEN NULL ELSE seen_at END
      WHERE key=@key AND resolved_at IS NULL`).run({ later, seen, open: r.state === "open" && newer ? 1 : 0, key: r.key });
    this.changedIf(res.changes);
    return true;
  }

  /** Settings → Notifications: the sources (Papr Work's, then apps that sent you something), your settings. (The delivery log stays: Focus will use it to say why something reached you.) */
  center() {
    const apps = (this.db.prepare(`SELECT source_id AS id, MAX(source_name) AS name FROM notices
      WHERE source_type='app' GROUP BY source_id ORDER BY MAX(updated_at) DESC LIMIT 50`).all() as { id: string; name: string }[])
      .map((a) => ({ id: appSourceId(a.id), name: a.name }));
    return { prefs: this.prefs, defaults: DEFAULT_NOTICE_PREFS, sources: PAPR_SOURCES, apps };
  }

  /** How much reached you over the last `days` days. Counts only; nothing leaves the device. */
  statsSummary(days = 7) {
    return this.stats.summary(days);
  }

  setPrefs(patch: unknown) {
    this.stats.bump("settings", "mute", countOffs(patch));
    this.prefs = this.prefsStore.set(patch);
    this.changed();
    syncPrefsToCloud();
    return this.center();
  }

  /** Settings changed on another device. Not sent back up (the sync already has this copy). */
  applyRemotePrefs(p: unknown) {
    this.prefs = this.prefsStore.replace(p);
    this.changed();
  }

  resetPrefs() {
    this.prefs = this.prefsStore.reset();
    this.changed();
    syncPrefsToCloud();
    return this.center();
  }

  /** Later (from Focus): out of Needs you and the Pen count until 3 PM (morning) or 9 AM tomorrow. Urgent can't be put off. */
  later(key: string, now = new Date()): string | null {
    const n = this.openByKey(key);
    if (!n || effectiveLevel(n) === "urgent") return null;
    const until = laterUntil(now).toISOString();
    this.db.prepare("UPDATE notices SET later_until=? WHERE key=? AND resolved_at IS NULL").run(until, key);
    this.stats.bump(sourceOf(n), "later");
    this.changed();
    emitMark({ keys: [key], state: "later", laterUntil: until });
    return until;
  }

  /** Bring a Later item back now. */
  unlater(key: string): boolean {
    const ok = this.changedIf(this.db.prepare("UPDATE notices SET later_until=NULL WHERE key=? AND resolved_at IS NULL").run(key).changes);
    if (ok) emitMark({ keys: [key], state: "open" });
    return ok;
  }

  /** Mute a source for an hour (from Focus): no desktop notifications, out of Needs you. Dots stay. */
  muteSource(sourceId: string, now = Date.now()): string {
    const until = new Date(now + MUTE_MS).toISOString();
    this.stats.bump(sourceId, "mute1h");
    this.setPrefs({ sources: { [sourceId]: { muteUntil: until } } });
    return until;
  }

  unmuteSource(sourceId: string) {
    return this.setPrefs({ sources: { [sourceId]: { muteUntil: null } } });
  }

  /** What the UI needs to draw Needs you: open notices and your settings (for mutes). */
  snapshot() {
    return { notices: this.listOpen(), prefs: this.prefs };
  }

  /** You clicked its OS notification: an event is done, a condition is seen (stays until fixed). */
  markSeenKey(key: string): boolean {
    const n = this.openByKey(key);
    const now = new Date().toISOString();
    const r = this.db.prepare(`UPDATE notices SET seen_at=@now,
      resolved_at=CASE WHEN type='event' THEN @now ELSE resolved_at END
      WHERE key=@key AND resolved_at IS NULL`).run({ now, key });
    if (n && r.changes) emitMark({ keys: [key], state: n.type === "event" ? "done" : "seen" });
    return this.changedIf(r.changes);
  }

  /** Why a notice reached you (or didn't), channel by channel. */
  deliveriesFor(noticeId: string) {
    return this.deliveries.forNotice(noticeId);
  }

  private deliverOs(notice: Notice, why: string[], sound: boolean, statSource = notice.source.id): void {
    const base = { noticeId: notice.id, noticeKey: notice.key, sourceId: notice.source.id, channel: "os" as const };
    if (this.deliveries.recentSent(notice.source.id) >= OS_CAP_PER_SOURCE) {
      this.deliveries.record({ ...base, status: "capped", why: [...why, `${notice.source.name} hit ${OS_CAP_PER_SOURCE} OS notifications in 10 min: kept as a dot`] });
      this.stats.bump(statSource, "capped");
      return;
    }
    this.deliveries.record({ ...base, status: "sent", why });
    this.stats.bump(statSource, "os");
    for (const l of osListeners) {
      try { l({ notice, why, sound, previews: previewsOf(this.prefs) }); } catch (e) { console.warn("[NoticeService] os listener failed:", e); }
    }
  }

  /** The sender clears a notice when it's fixed or answered. */
  resolve(key: string): boolean {
    const r = this.db.prepare("UPDATE notices SET resolved_at=? WHERE key=? AND resolved_at IS NULL")
      .run(new Date().toISOString(), key);
    if (r.changes) emitMark({ keys: [key], state: "done" });
    return this.changedIf(r.changes);
  }

  /** Clear every open notice in a group, e.g. all requests for one key name across chats. */
  resolveGroup(group: string): boolean {
    const r = this.db.prepare("UPDATE notices SET resolved_at=? WHERE resolve_group=? AND resolved_at IS NULL")
      .run(new Date().toISOString(), group);
    return this.changedIf(r.changes);
  }

  /** You looked at the thing: its events are done; its conditions stay until fixed. */
  markSeen(ownerKind: NoticeOwnerKind, ownerId: string): boolean {
    const now = new Date().toISOString();
    const before = (this.db.prepare(`SELECT key, type FROM notices WHERE owner_kind=? AND owner_id=? AND resolved_at IS NULL
      AND (type='event' OR seen_at IS NULL)`).all(ownerKind, ownerId) as { key: string; type: string }[]);
    const tx = this.db.transaction(() => {
      const a = this.db.prepare(`UPDATE notices SET seen_at=@now, resolved_at=@now WHERE owner_kind=@k AND owner_id=@id
        AND type='event' AND resolved_at IS NULL`).run({ now, k: ownerKind, id: ownerId });
      const b = this.db.prepare(`UPDATE notices SET seen_at=@now WHERE owner_kind=@k AND owner_id=@id
        AND type='condition' AND resolved_at IS NULL AND seen_at IS NULL`).run({ now, k: ownerKind, id: ownerId });
      return a.changes + b.changes;
    });
    const n = tx();
    if (n) {
      emitMark({ keys: before.filter((x) => x.type === "event").map((x) => x.key), state: "done" });
      emitMark({ keys: before.filter((x) => x.type !== "event").map((x) => x.key), state: "seen" });
    }
    return this.changedIf(n);
  }

  /** What you're looking at. Looking at a thing (window in front) marks it seen. */
  setViewing(v: Viewing): void {
    this.viewing = v;
    if (v.foreground) for (const o of v.owners) this.markSeen(o.kind, o.id);
  }

  listOpen(): Notice[] {
    const rows = this.db.prepare(`SELECT * FROM notices WHERE resolved_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC`).all(new Date().toISOString()) as NoticeRow[];
    return rows.map(rowToNotice);
  }

  close(): void {
    this.db.close();
  }

  private isViewing(kind: NoticeOwnerKind, id: string): boolean {
    return this.viewing.foreground && this.viewing.owners.some((o) => o.kind === kind && o.id === id);
  }

  private openByKey(key: string): Notice | null {
    const row = this.db.prepare("SELECT * FROM notices WHERE key=? AND resolved_at IS NULL").get(key) as NoticeRow | undefined;
    return row ? rowToNotice(row) : null;
  }

  private changedIf(n: number): boolean {
    if (n > 0) this.changed();
    return n > 0;
  }

  private changed(): void {
    if (!listeners.size) return;
    const open = this.listOpen();
    for (const l of listeners) {
      try { l(open, this.prefs); } catch (e) { console.warn("[NoticeService] listener failed:", e); }
    }
  }
}

let instance: NoticeService | null = null;

export function getNoticeService(): NoticeService {
  if (!instance) instance = new NoticeService();
  return instance;
}

/** Your settings follow you to the web: mirror them to the memory server (debounced, best-effort). */
function syncPrefsToCloud(): void {
  void import("../focusCloud/focusCloudSync.js").then((m) => m.scheduleFocusCloudSync("notification settings")).catch(() => undefined);
}

/** Best-effort: notices must never break the work that raises them. */
export function tryNotify(input: NoticeInput | RoutedNotice): void {
  try { getNoticeService().notify(input); } catch (e) { console.warn("[NoticeService] notify failed:", e); }
}

export function tryResolve(key: string): void {
  try { getNoticeService().resolve(key); } catch (e) { console.warn("[NoticeService] resolve failed:", e); }
}

export function tryResolveGroup(group: string): void {
  try { getNoticeService().resolveGroup(group); } catch (e) { console.warn("[NoticeService] resolveGroup failed:", e); }
}

/** Reset singleton after org/namespace workspace switch (the table lives in the workspace). */
export function resetNoticeServiceForWorkspaceSwitch(): void {
  instance?.close();
  instance = null;
}
