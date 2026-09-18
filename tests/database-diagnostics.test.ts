import { afterEach, describe, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { fork, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseDiagnosticCollector, sameDatabase } from "../src/gateway/services/databaseDiagnostics/collector.js";
import { DatabaseConnectionTrace, getDatabaseDiagnosticTransportStatus, sqlOperationKind, stopDatabaseDiagnosticTransport } from "../src/gateway/services/databaseDiagnostics/trace.js";
import type { DatabaseConnectionRecord } from "../src/gateway/services/databaseDiagnostics/types.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { stopDatabaseDiagnosticTransport(); vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function environment() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pdt-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const endpoint = process.platform === "win32" ? String.raw`\\.\pipe` + "\\" + `pdt-${path.basename(dir)}` : path.join(dir, "t.sock");
  const collector = new DatabaseDiagnosticCollector(); await collector.listen(endpoint);
  expect(collector.status).toBe("listening"); cleanup.push(() => collector.close());
  vi.stubEnv("PAPR_DB_DIAGNOSTICS_SOCKET", endpoint); vi.stubEnv("PAPR_DATABASE_DIAGNOSTICS", "1");
  return { dir, collector, endpoint };
}

describe("database connection evidence", () => {
  test("classifies statements without retaining SQL literals or parameters", () => {
    expect(sqlOperationKind("/* secret */ SELECT * FROM private_table WHERE token='hidden'")).toBe("read");
    expect(sqlOperationKind("-- hi\n BEGIN EXCLUSIVE")).toBe("transaction-begin");
    expect(sqlOperationKind("PRAGMA wal_checkpoint(TRUNCATE)")).toBe("checkpoint");
    expect(sqlOperationKind("WITH rows AS (...) UPDATE x SET y=1")).toBe("unknown");
  });
  test("aliases resolve to one file identity; idle and disconnected connections are not blamed", async () => {
    const { dir, collector } = await environment();
    const dbPath = path.join(dir, "data.db"); await writeFile(dbPath, "fixture");
    await symlink(dbPath, path.join(dir, "alias.db")); await link(dbPath, path.join(dir, "hard.db"));
    const traces = [dbPath, path.join(dir, "alias.db"), path.join(dir, "hard.db")].map(p => new DatabaseConnectionTrace(p, "test-owner", "better-sqlite3"));
    await vi.waitFor(() => expect(collector.snapshot().connections).toHaveLength(3));
    await vi.waitFor(() => expect(collector.snapshot().connections.every(r => r.identity === "file")).toBe(true));
    expect(new Set(collector.snapshot().connections.map(r => r.databaseId)).size).toBe(1);
    const end = traces[0].begin("prepare:read"); traces[1].transaction(true);
    await vi.waitFor(() => expect(collector.snapshot().connections.filter(r => r.operations.length || r.transaction.state === "active")).toHaveLength(2));
    const waiting = collector.evidence(process.pid).waitingCandidates[0];
    // Vitest's test worker has a nonzero threadId; correlation of the main thread is tested in the real process test.
    if (traces[0].record.threadId === 0) expect(waiting.suspectedCompetingConnections).toHaveLength(1);
    stopDatabaseDiagnosticTransport();
    await vi.waitFor(() => expect(collector.snapshot().sources.every(s => !s.connected)).toBe(true));
    expect(collector.evidence(process.pid).waitingCandidates).toEqual([]);
    end(); traces.forEach(t => t.close());
  });
  test("does not match different physical files at a reused path or separate in-memory DBs", () => {
    const base = { databasePath: "/tmp/a.db", identity: "file", databaseId: "inode1", pathId: "path1" } as DatabaseConnectionRecord;
    expect(sameDatabase(base, { ...base, databaseId: "inode2" })).toBe(false);
    expect(sameDatabase({ ...base, identity: "path" }, base)).toBe(true);
    expect(sameDatabase({ ...base, identity: "memory" }, { ...base, identity: "memory", databaseId: "another" })).toBe(false);
  });
  test("failure records contain error codes, not error messages; inactive work is removed", async () => {
    const { collector } = await environment();
    const trace = new DatabaseConnectionTrace(":memory:", "diagnostic-test", "better-sqlite3");
    await vi.waitFor(() => expect(getDatabaseDiagnosticTransportStatus().connected).toBe(true));
    const end = trace.begin("prepare:read"); end(Object.assign(new Error("private payload"), { code: "SQLITE_BUSY" }));
    await vi.waitFor(() => expect(collector.snapshot().recent).toHaveLength(1));
    expect(collector.snapshot().recent[0].errorCode).toBe("SQLITE_BUSY");
    expect(JSON.stringify(collector.snapshot())).not.toContain("private payload");
    trace.close(); await vi.waitFor(() => expect(collector.snapshot().connections).toHaveLength(0));
  });
});

async function runtime(): Promise<string> {
  // Never rebuild the user's Electron native addon to fit the test runner.
  const candidates = [process.execPath, require("electron") as string];
  for (const executable of candidates) {
    const supported = await new Promise<boolean>(resolve => execFile(executable,
      ["-e", "const D=require('better-sqlite3');new D(':memory:').close()"],
      { cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10000 }, error => resolve(!error)));
    if (supported) return executable;
  }
  throw new Error("No installed runtime can load the native SQLite module");
}

test("real SQLite lock wait identifies the waiting DB and competing transaction while reader is blocked", async () => {
  const { dir, collector, endpoint } = await environment();
  const executable = await runtime();
  const fixture = path.join(dir, "actor.mjs");
  const source = `import { createRequire } from 'node:module';
    import { openDiagnosticDatabase } from ${JSON.stringify(path.join(repo, "src/gateway/services/databaseDiagnostics/sqlite.ts"))};
    import { getDatabaseDiagnosticTransportStatus } from ${JSON.stringify(path.join(repo, "src/gateway/services/databaseDiagnostics/trace.ts"))};
    const require = createRequire(${JSON.stringify(path.join(repo, "package.json"))});
    const Database = require('better-sqlite3');
    const role = process.argv[2];
    const db = openDiagnosticDatabase(Database, role, process.argv[3], {timeout: 10000});
    while (!getDatabaseDiagnosticTransportStatus().connected) await new Promise(r=>setTimeout(r,20));
    await new Promise(r=>setTimeout(r,100));
    process.on('disconnect',()=>process.exit(0));
    if (role === 'holder') {
      db.exec('CREATE TABLE entries (value TEXT)');
      db.prepare('INSERT INTO entries VALUES (?)').run('private-value-not-for-report');
      db.exec('BEGIN EXCLUSIVE');
      process.send({type:'held'});
      process.on('message',()=>{db.exec('COMMIT');db.close();process.send({type:'released'});});
    } else {
      process.send({type:'reading'});
      const row = db.prepare('SELECT value FROM entries').get();
      const tx = db.transaction(function(value){ db.prepare('INSERT INTO entries VALUES (?)').run(value); return this.answer; });
      const txResult = tx.immediate.call({answer:42}, 'another-private-value');
      let rolledBack = false;
      const marker = new Error('original-error');
      try { db.transaction(()=>{db.prepare('INSERT INTO entries VALUES (?)').run('rollback');throw marker;}).exclusive(); }
      catch(error){rolledBack = error === marker;}
      const rows = [...db.prepare('SELECT value FROM entries').iterate()];
      const iterator = db.prepare('SELECT value FROM entries').iterate(); iterator.next(); iterator.return();
      const bound = db.prepare('SELECT value FROM entries WHERE value=?').bind('another-private-value').get();
      const okay = row.value === 'private-value-not-for-report' && txResult === 42 && rolledBack && rows.length === 2 && bound.value === 'another-private-value' && tx.default === tx && tx.database === db;
      db.close();process.send({type:'done',okay});
    }`;
  await build({ stdin: { contents: source, resolveDir: repo, loader: "ts" }, outfile: fixture, bundle: true, platform: "node", format: "esm" });
  const dbPath = path.join(dir, "data.db");
  const spawnActor = (role: string) => {
    const child = fork(fixture, [role, dbPath], { execPath: executable, execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PAPR_DB_DIAGNOSTICS_SOCKET: endpoint }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr?.on("data", data => { stderr += String(data).slice(0, 2000); });
    child.on("exit", code => { if (code && code !== 0) console.error(stderr); });
    cleanup.push(() => { child.kill(); }); return child;
  };
  const holder = spawnActor("holder"); await once(holder, "message");
  const reader = spawnActor("reader");
  const done = new Promise<{ okay: boolean }>(resolve => reader.on("message", m => { if (m.type === "done") resolve(m); }));
  await vi.waitFor(() => {
    const evidence = collector.evidence(reader.pid!);
    expect(evidence.waitingCandidates).toHaveLength(1);
    expect(evidence.waitingCandidates[0].waiting.operations.some(op => op.kind === "prepare:read")).toBe(true);
    expect(evidence.waitingCandidates[0].suspectedCompetingConnections, JSON.stringify(collector.snapshot().connections)).toHaveLength(1);
  }, { timeout: 5000 });
  const evidence = collector.evidence(reader.pid!);
  expect(evidence.waitingCandidates[0].waiting.databasePath).toMatch(/\/data.db$/);
  expect(evidence.waitingCandidates[0].suspectedCompetingConnections[0]).toMatchObject({ pid: holder.pid, owner: "holder", transaction: { state: "active" } });
  expect(JSON.stringify(evidence)).not.toContain("private-value");
  holder.send({ type: "release" });
  expect((await done).okay).toBe(true);
}, 30000);

test("burst recovery preserves connection metadata, latest activity and bounded error history", async () => {
 const { collector } = await environment();
 const trace = new DatabaseConnectionTrace(":memory:", "burst-owner", "turso");
 await vi.waitFor(() => expect(getDatabaseDiagnosticTransportStatus().connected).toBe(true));
 const before = getDatabaseDiagnosticTransportStatus();
 // A synchronous producer cannot service drain callbacks during this burst.
 for(let i=0;i<4000;i++){const end=trace.begin("read");end();}
 const failed=trace.begin("write");failed(Object.assign(new Error("secret payload"),{code:"SQLITE_BUSY"}));
 const end=trace.begin("pull");
 await vi.waitFor(() => {
   const c=collector.snapshot().connections.find(c=>c.connectionId===trace.record.connectionId);
   expect(c?.owner).toBe("burst-owner");expect(c?.engine).toBe("turso");expect(c?.operations.map(o=>o.kind)).toEqual(["pull"]);
   expect(collector.snapshot().recent.some(c=>c.connection.connectionId===trace.record.connectionId&&c.errorCode==="SQLITE_BUSY")).toBe(true);
 });
 const after=getDatabaseDiagnosticTransportStatus();
 expect(after.coalescedUpdates).toBeGreaterThan(before.coalescedUpdates);
 expect(after.droppedHistory).toBe(before.droppedHistory);
 expect(JSON.stringify(collector.snapshot())).not.toContain("secret payload");
 end();trace.close();await vi.waitFor(()=>expect(collector.snapshot().connections.some(c=>c.connectionId===trace.record.connectionId)).toBe(false));
});
