import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { LocalStorageProvider } from "../src/gateway/services/storage/LocalStorageProvider.js";
import { getPerformanceDiagnostics, resetPerformanceDiagnosticsForTests } from "../src/core/utils/performanceDiagnostics.js";

// These maintenance tasks are unrelated to reads; avoid scheduled writes after cleanup.
vi.mock("../src/gateway/services/storage/toolPayloadMigration.js", () => ({ startToolPayloadMigration: vi.fn() }));
vi.mock("../src/gateway/services/storage/contextFootprintStore.js", async (original) => ({
  ...await original<typeof import("../src/gateway/services/storage/contextFootprintStore.js")>(),
  scheduleContextFootprintBackfill: vi.fn(),
}));
vi.mock("../src/gateway/services/storage/contextStatsCache.js", async (original) => ({
  ...await original<typeof import("../src/gateway/services/storage/contextStatsCache.js")>(),
  scheduleContextStatsRebuild: vi.fn(),
}));
vi.mock("../src/gateway/services/storage/ChatExporter.js", () => ({ ChatExporter: class { async initialize() {} } }));

let temp: string;
let workerUrl: URL;
let provider: LocalStorageProvider;
let db: Database.Database;
let sequence = 0;
beforeAll(async () => {
  temp = mkdtempSync(path.join(os.tmpdir(), "papr-chat-worker-test-"));
  symlinkSync(path.resolve("node_modules"), path.join(temp, "node_modules"), "dir");
  const workerPath = path.join(temp, "db-query-worker.mjs");
  await build({ entryPoints: ["src/gateway/workers/db-query-worker.ts"], outfile: workerPath,
    bundle: true, platform: "node", format: "esm", packages: "external" });
  workerUrl = pathToFileURL(workerPath);
});
beforeEach(async () => {
  provider = new LocalStorageProvider(path.join(temp, String(++sequence)), workerUrl);
  await provider.initialize();
  db = (provider as unknown as { db: Database.Database }).db;
  await provider.createChat("chat", "Worker chat");
  db.prepare(`INSERT INTO messages (id, chat_id, role, content, timestamp, prompt_tokens, completion_tokens, total_tokens, cost)
    VALUES (?, 'chat', 'assistant', ?, ?, ?, 5, ?, 0.25)`).run("a", "first", "2026-09-18T00:00:00.000Z", 10, 15);
  db.prepare(`INSERT INTO messages (id, chat_id, role, content, timestamp, prompt_tokens, completion_tokens, total_tokens, cost)
    VALUES (?, 'chat', 'assistant', ?, ?, ?, 5, ?, 0.5)`).run("b", "second", "2026-09-18T00:00:01.000Z", 20, 25);
  db.prepare("UPDATE chats SET message_count=2 WHERE id='chat'").run();
});
afterEach(() => { provider?.close(); resetPerformanceDiagnosticsForTests(); });
afterAll(() => rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));

test("chat reads preserve committed data, pagination, usage totals and diagnostics without main-thread SELECT", async () => {
  // If any migrated read silently falls back to the writer connection, fail.
  const original = db.prepare.bind(db);
  const prepare = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (/^\s*SELECT/i.test(sql)) throw new Error("Main-thread SELECT");
    return original(sql);
  }) as typeof db.prepare);
  try {
    expect((await provider.loadMessages("chat")).map(m => m.id)).toEqual(["a", "b"]);
    expect((await provider.loadMessages("chat", 1)).map(m => m.id)).toEqual(["b"]);
    expect((await provider.loadMessages("chat", 1, 1)).map(m => m.id)).toEqual(["a"]);
    expect(await provider.getChat("missing")).toBeNull();
    expect((await provider.getChat("chat"))?.title).toBe("Worker chat");
    await provider.updateChat("chat", { title: "Changed" });
    expect((await provider.getChat("chat"))?.title).toBe("Changed");
    expect(await provider.getChatStats("chat")).toMatchObject({ message_count: 2, token_count: 40, cost_total: 0.75 });
    expect(await provider.getTurnUsage("chat")).toMatchObject({ lastTurn: { messageId: "b" },
      recentTurns: [{ messageId: "b" }, { messageId: "a" }], totals: { turns: 2, cost: 0.75, promptTokens: 30, completionTokens: 10 } });
    expect(await provider.getTurnUsage("missing")).toMatchObject({ lastTurn: null, recentTurns: [], totals: { turns: 0 } });
    expect((await provider.listChats()).map(c => c.id)).toContain("chat");
    expect((await provider.loadMessagesForLLM("chat")).map(m => m.content)).toEqual(["first", "second"]);
    expect(getPerformanceDiagnostics().recent.some(op => op.name === "chat-db:getTurnUsage")).toBe(true);
  } finally { prepare.mockRestore(); }
}, 15000);

test("expensive SQLite scans leave the main event loop responsive and worker errors recover", async () => {
  const reads = provider as unknown as { readRows: (name: string, sql: string) => Promise<Array<{ total: number }>> };
  await provider.getChat("chat"); // Warm the actual worker before measuring.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const rows = await reads.readRows("testScan", `WITH RECURSIVE n(x) AS (
      VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000000
    ) SELECT SUM(x) AS total FROM n`);
    expect(rows[0].total).toBe(2000001000000);
    expect(ticks).toBeGreaterThan(2);
  } finally { clearInterval(timer); }
  await expect(reads.readRows("badQuery", "SELECT * FROM missing_table")).rejects.toThrow();
  expect((await provider.getChat("chat"))?.title).toBe("Worker chat");
  provider.close();
  await expect(provider.getChat("chat")).rejects.toThrow("closed");
  provider = undefined as unknown as LocalStorageProvider;
}, 15000);
