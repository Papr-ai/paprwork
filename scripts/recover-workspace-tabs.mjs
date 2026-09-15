#!/usr/bin/env node
/**
 * Recover tab rows that a destructive `saveTabs` replaced.
 *
 * `AppStateStorage.saveTabs` is `DELETE FROM tabs` followed by re-insert, so a
 * save that writes a pruned list leaves the previous rows in the database's free
 * pages and in older WAL frames. They are not overwritten until SQLite reuses
 * those pages, which is why this must be run before the app writes much more.
 *
 * Records are located by brute-force scan rather than by walking the b-tree: the
 * point of the exercise is pages whose headers no longer reference the cells, so
 * the structure that would normally find them is exactly what is gone.
 *
 * A second source is the `app_state` table, which lives in the same file but is
 * written by a different code path (`app:save_state`) and so survives a
 * destructive tab save. Its `history` is authoritative for which tabs were
 * open: `closeTab` filters closed ids out of it, so anything still listed was
 * open when the state was last saved.
 *
 * Read-only. Prints what it found and writes nothing unless --restore is passed.
 *
 *   node scripts/recover-workspace-tabs.mjs --db <path to app-state.db>
 *   node scripts/recover-workspace-tabs.mjs --db <path> --restore
 */

import { readFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const KNOWN_TAB_TYPES = new Set([
  "chat",
  "app",
  "apps",
  "document",
  "documents",
  "memory",
  "settings",
  "home",
  "landing",
  "getting-started",
  "jobs",
  "databases",
  "wiki",
  "catalog",
  "subagents",
  "sub-agents",
  "permissions",
]);
const DISPLAY_MODES = new Set(["standalone", "parent", "child"]);
/** Columns before `metadata_json` was added, and after. Both shapes exist on disk. */
const COLUMN_COUNTS = new Set([10, 11]);

function readVarint(buf, offset) {
  let value = 0n;
  for (let i = 0; i < 9; i += 1) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    if (i === 8) {
      value = (value << 8n) | BigInt(byte);
      return { value, size: 9 };
    }
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, size: i + 1 };
  }
  return null;
}

function serialTypeSize(type) {
  if (type === 0 || type === 8 || type === 9) return 0;
  if (type >= 1 && type <= 4) return type;
  if (type === 5) return 6;
  if (type === 6 || type === 7) return 8;
  if (type === 10 || type === 11) return null;
  return Math.floor((type - 12) / 2);
}

function isTextType(type) {
  return type >= 13 && type % 2 === 1;
}

function readValue(buf, offset, type) {
  const size = serialTypeSize(type);
  if (size === null || offset + size > buf.length) return null;
  if (type === 0) return { value: null, size: 0 };
  if (type === 8) return { value: 0, size: 0 };
  if (type === 9) return { value: 1, size: 0 };
  if (type >= 1 && type <= 6) {
    let n = 0n;
    for (let i = 0; i < size; i += 1) n = (n << 8n) | BigInt(buf[offset + i]);
    // Sign-extend.
    const bits = BigInt(size * 8);
    const signBit = 1n << (bits - 1n);
    if (n & signBit) n -= 1n << bits;
    return { value: Number(n), size };
  }
  if (type === 7) return { value: buf.readDoubleBE(offset), size };
  if (isTextType(type)) {
    return { value: buf.toString("utf8", offset, offset + size), size };
  }
  return { value: buf.subarray(offset, offset + size), size };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Try to read one tabs-table record starting exactly at `offset`. */
function tryParseTabRecord(buf, offset) {
  const header = readVarint(buf, offset);
  if (!header) return null;
  const headerSize = Number(header.value);
  // 10-11 columns: header is a small, bounded size. Reject anything else fast.
  if (headerSize < 11 || headerSize > 40) return null;
  if (offset + headerSize > buf.length) return null;

  const types = [];
  let cursor = offset + header.size;
  const headerEnd = offset + headerSize;
  while (cursor < headerEnd) {
    const st = readVarint(buf, cursor);
    if (!st) return null;
    types.push(Number(st.value));
    cursor += st.size;
  }
  if (cursor !== headerEnd) return null;
  if (!COLUMN_COUNTS.has(types.length)) return null;

  // Shape check before touching the body: id/type/title/display_mode are TEXT
  // and never null, position/is_favorite are integers. This is what keeps the
  // brute-force scan from reporting records belonging to other tables.
  if (!isTextType(types[0])) return null;
  if (!isTextType(types[1])) return null;
  if (!isTextType(types[3])) return null;
  if (!isTextType(types[4])) return null;
  const intish = (t) => (t >= 0 && t <= 6) || t === 8 || t === 9;
  if (!intish(types[6]) || !intish(types[7])) return null;
  if (!isTextType(types[8]) || !isTextType(types[9])) return null;

  const values = [];
  let body = headerEnd;
  for (const type of types) {
    const read = readValue(buf, body, type);
    if (!read) return null;
    values.push(read.value);
    body += read.size;
  }

  const [id, type, entityId, title, displayMode, parentTabId, position, isFavorite, createdAt, lastAccessedAt, metadataJson] =
    values;

  if (!KNOWN_TAB_TYPES.has(type)) return null;
  if (!DISPLAY_MODES.has(displayMode)) return null;
  if (typeof createdAt !== "string" || !ISO_RE.test(createdAt)) return null;
  if (typeof lastAccessedAt !== "string" || !ISO_RE.test(lastAccessedAt)) return null;
  if (typeof id !== "string" || id.length === 0 || id.length > 300) return null;

  return {
    id,
    type,
    entity_id: typeof entityId === "string" ? entityId : "",
    title: typeof title === "string" ? title : type,
    display_mode: displayMode,
    parent_tab_id: typeof parentTabId === "string" ? parentTabId : null,
    position: Number(position) || 0,
    is_favorite: Number(isFavorite) || 0,
    created_at: createdAt,
    last_accessed_at: lastAccessedAt,
    metadata_json: typeof metadataJson === "string" ? metadataJson : null,
    _end: body,
  };
}

function scanBuffer(buf, found) {
  for (let offset = 0; offset < buf.length; offset += 1) {
    const record = tryParseTabRecord(buf, offset);
    if (!record) continue;
    const existing = found.get(record.id);
    // Keep the newest image of each tab: an older WAL frame may hold a stale
    // title for a tab that was later renamed.
    if (!existing || record.last_accessed_at > existing.last_accessed_at) {
      found.set(record.id, record);
    }
    offset = record._end - 1;
  }
}

/**
 * Recover tab ids from `app_state`, which a destructive `saveTabs` does not touch.
 *
 * Yields ids only — titles for chat tabs are resolved from chats.db, and the
 * parent/child split pairing is not recorded anywhere in this table, so every
 * recovered tab comes back standalone rather than guessed into a split.
 */
function recoverFromAppState(dbPath, live) {
  let stateRows;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    stateRows = db.prepare("SELECT key, value, updated_at FROM app_state").all();
    db.close();
  } catch {
    return [];
  }

  const state = new Map(stateRows.map((row) => [row.key, row.value]));
  const savedAt = stateRows[0]?.updated_at ?? new Date().toISOString();
  const readJson = (key, fallback) => {
    try {
      return JSON.parse(state.get(key) ?? "");
    } catch {
      return fallback;
    }
  };

  const ids = new Set();
  for (const id of readJson("history", [])) if (typeof id === "string") ids.add(id);
  for (const id of Object.keys(readJson("splitRatios", {}))) ids.add(id);
  const activeTabId = state.get("activeTabId");
  if (activeTabId) ids.add(activeTabId);

  const chatTitles = new Map();
  const chatsDb = path.join(path.dirname(dbPath), "chats.db");
  if (existsSync(chatsDb)) {
    try {
      const db = new DatabaseSync(chatsDb, { readOnly: true });
      for (const row of db.prepare("SELECT id, title FROM chats").all()) {
        chatTitles.set(row.id, row.title);
      }
      db.close();
    } catch {
      /* titles are cosmetic; ids are what matter */
    }
  }

  const rows = [];
  for (const id of ids) {
    if (live.has(id)) continue;
    // A temp id belongs to a chat that was never created server-side, so
    // restoring it would only reopen an empty composer.
    if (id.startsWith("chat-temp-")) continue;

    const chatId = id.startsWith("chat-") ? id.slice("chat-".length) : null;
    if (!chatId) continue; // Non-chat tabs come from the record scan, with titles and icons.
    const title = chatTitles.get(chatId);
    if (!title) continue; // Chat no longer exists — do not resurrect a dead tab.

    rows.push({
      id,
      type: "chat",
      entity_id: chatId,
      title,
      display_mode: "standalone",
      parent_tab_id: null,
      position: 0,
      is_favorite: 0,
      created_at: savedAt,
      last_accessed_at: savedAt,
      metadata_json: null,
      _source: "app_state",
    });
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  if (dbIndex === -1 || !args[dbIndex + 1]) {
    console.error("Usage: recover-workspace-tabs.mjs --db <app-state.db> [--restore]");
    process.exit(1);
  }
  const dbPath = args[dbIndex + 1];
  const restore = args.includes("--restore");

  const sources = [dbPath, `${dbPath}-wal`].filter((p) => existsSync(p));
  if (sources.length === 0) {
    console.error(`No such database: ${dbPath}`);
    process.exit(1);
  }

  const found = new Map();
  for (const source of sources) {
    const buf = readFileSync(source);
    const before = found.size;
    scanBuffer(buf, found);
    console.log(
      `Scanned ${source} (${(buf.length / 1024).toFixed(0)} KiB) — ${found.size - before} new tab record(s)`,
    );
  }

  const live = new Set();
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    for (const row of db.prepare("SELECT id FROM tabs").all()) live.add(row.id);
    db.close();
  } catch {
    /* database may be unreadable; recovery still useful */
  }

  const recovered = [...found.values()].filter(
    // A temp id belongs to a chat never created server-side: restoring it only
    // reopens an empty composer, and its entityId resolves to nothing.
    (row) => !live.has(row.id) && !row.id.startsWith("chat-temp-"),
  );
  console.log(`\nLive tabs: ${live.size}. Recoverable (not currently present): ${recovered.length}\n`);

  // Rows written by one `saveTabs` call share a last_accessed_at. The largest
  // such group is the last full tab bar before the destructive save, which is
  // what we want to restore — not the union of every state ever saved.
  const byTimestamp = new Map();
  for (const row of recovered) {
    const group = byTimestamp.get(row.last_accessed_at) ?? [];
    group.push(row);
    byTimestamp.set(row.last_accessed_at, group);
  }
  const groups = [...byTimestamp.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [ts, rows] of groups.slice(0, 6)) {
    console.log(`  ${ts}  ${String(rows.length).padStart(3)} tab(s)`);
  }

  const fromRecords = groups[0]?.[1].slice().sort((a, b) => a.position - b.position) ?? [];

  // Second source: tabs the record scan missed because their pages were reused.
  const recordIds = new Set([...fromRecords.map((r) => r.id), ...live]);
  const fromState = recoverFromAppState(dbPath, recordIds);

  const chosen = [...fromRecords, ...fromState];
  if (chosen.length === 0) {
    console.log("Nothing to recover.");
    return;
  }

  console.log(`\nRecovered tab bar (${chosen.length} tabs):\n`);
  for (const row of chosen) {
    const source = row._source === "app_state" ? "app_state" : "free pages";
    console.log(`  ${row.type.padEnd(11)} ${String(row.title).slice(0, 56).padEnd(58)} ${source}`);
  }

  if (!restore) {
    console.log("\nDry run. Re-run with --restore to write these back.");
    return;
  }

  const backup = `${dbPath}.before-tab-recovery-${Date.now()}`;
  copyFileSync(dbPath, backup);
  console.log(`\nBacked up current database to ${backup}`);

  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tabs (
      id, type, entity_id, title, display_mode, parent_tab_id,
      position, is_favorite, created_at, last_accessed_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  // Restored tabs go after the live ones so the surviving tab keeps its place.
  const base = live.size;
  db.exec("BEGIN");
  chosen.forEach((row, index) => {
    // An orphaned child renders full-screen but is hidden from the tab bar, so
    // a parent that did not survive means the child must stand alone.
    const parentRecovered = chosen.some((other) => other.id === row.parent_tab_id);
    const result = insert.run(
      row.id,
      row.type,
      row.entity_id,
      row.title,
      parentRecovered ? row.display_mode : row.display_mode === "child" ? "standalone" : row.display_mode,
      parentRecovered ? row.parent_tab_id : null,
      base + index,
      row.is_favorite,
      row.created_at,
      row.last_accessed_at,
      row.metadata_json,
    );
    inserted += result.changes;
  });
  db.exec("COMMIT");
  const total = db.prepare("SELECT count(*) n FROM tabs").get().n;
  db.close();
  console.log(`Restored ${inserted} tab(s). Database now holds ${total} tab(s).`);
  console.log("Restart the app (or switch workspace and back) to see them.");
}

main();
