import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectAppOpFiles,
  listLocalCodeChanges,
  listOversizedFilesInAppDir,
  listRemovableWebPaths,
} from "../src/gateway/services/syncV3/collectAppOpFiles.js";
import { applyAckedBlobOids, readOidCache, removeCachedPaths } from "../src/gateway/services/syncV3/OidCache.js";
import {
  approveSyncDeletes,
  readSyncManifest,
  updateSyncManifest,
} from "../src/gateway/services/syncV3/SyncManifest.js";
import { planRemoteDeletes } from "../src/gateway/services/syncV3/syncDeletes.js";
import { computeBlobOidForContent } from "../src/gateway/services/syncV3/computeParentHash.js";
import { buildOversizedAppFilesReport, summarizeUnsyncable } from "../src/gateway/services/cloudSync/oversizedAppFilesReport.js";

const appId = "app-del-1";
const dirs: string[] = [];
let home: string;
let prev: string | undefined;

function newHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sync-deletes-"));
  dirs.push(h);
  fs.mkdirSync(path.join(h, "data"), { recursive: true });
  fs.mkdirSync(path.join(h, "apps", appId), { recursive: true });
  return h;
}
function use(h: string) {
  home = h;
  process.env.PAPR_HOME = h;
}

beforeEach(() => {
  prev = process.env.PAPR_HOME;
  use(newHome());
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAPR_HOME;
  else process.env.PAPR_HOME = prev;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const appFile = (rel: string) => path.join(home, "apps", appId, rel);
const write = (rel: string, content = "x\n") => {
  fs.mkdirSync(path.dirname(appFile(rel)), { recursive: true });
  fs.writeFileSync(appFile(rel), content);
};
const oid = (c: string) => computeBlobOidForContent(c);

/** Simulate a completed sync of these files: web has them, manifest agrees. */
async function synced(files: Record<string, string>) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([p, c]) => ({ path: p, blobOid: await oid(c) })),
  );
  for (const [p, c] of Object.entries(files)) write(p, c);
  await applyAckedBlobOids(appId, entries);
  await updateSyncManifest(appId, { add: entries.map((e) => ({ path: e.path, oid: e.blobOid })) });
}
const deletesIn = (files: Array<{ path: string; content: string | null; parentHash: string }>) =>
  files.filter((f) => f.content === null);

describe("publish: deletes come from the manifest, not the cache", () => {
  it("deletes a file this computer synced and then removed, with the agreed OID as parentHash", async () => {
    await synced({ "index.html": "<html/>", "old.css": "a{}" });
    fs.rmSync(appFile("old.css"));
    const { files, heldDeletes } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files)).toEqual([{ path: "old.css", content: null, parentHash: await oid("a{}") }]);
    expect(heldDeletes).toEqual([]);
  });

  it("never deletes the writer's README scaffold (on the web, never local)", async () => {
    await synced({ "index.html": "<html/>" });
    await applyAckedBlobOids(appId, [{ path: "README.md", blobOid: "scaffold" }]);
    const { files } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files)).toEqual([]);
    const { webOnly } = await listLocalCodeChanges(home, appId);
    expect(webOnly).toEqual([]); // not even offered for removal
  });

  it("never deletes a web file this computer never had — it is listed as web-only instead", async () => {
    await synced({ "index.html": "<html/>" });
    await applyAckedBlobOids(appId, [{ path: "data/databases/x/migrations/0002_a.sql", blobOid: "o" }]);
    const { files } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files)).toEqual([]);
    expect((await listLocalCodeChanges(home, appId)).webOnly).toEqual([
      "data/databases/x/migrations/0002_a.sql",
    ]);
  });

  it("a file that still exists but stopped being tracked (now ignored) is not deleted from the web", async () => {
    await synced({ "index.html": "<html/>", "clip.txt": "t" });
    fs.renameSync(appFile("clip.txt"), appFile("clip.mov")); // gone as tracked path
    await updateSyncManifest(appId, { add: [{ path: "clip.mov", oid: "o" }] });
    await applyAckedBlobOids(appId, [{ path: "clip.mov", blobOid: "o" }]);
    const { files } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files).map((f) => f.path)).toEqual(["clip.txt"]);
  });

  it("existing installs: no manifest → nothing is deleted on the first publish", async () => {
    write("index.html", "<html/>");
    await applyAckedBlobOids(appId, [
      { path: "index.html", blobOid: await oid("<html/>") },
      { path: "gone.ts", blobOid: "o1" },
    ]);
    const { files } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files)).toEqual([]);
    // ...but the unchanged file seeds the manifest for next time
    expect([...(await readSyncManifest(appId)).files.keys()]).toEqual(["index.html"]);
  });

  it("an empty or missing app folder never deletes anything", async () => {
    await synced({ "index.html": "<html/>", "a.ts": "a" });
    fs.rmSync(path.join(home, "apps", appId), { recursive: true });
    const { files } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files)).toEqual([]);
  });

  it("more than 10 deletes are held until confirmed; confirmed ones are then sent", async () => {
    const files: Record<string, string> = { "index.html": "<html/>" };
    for (let i = 0; i < 12; i++) files[`f${i}.ts`] = `v${i}`;
    await synced(files);
    for (let i = 0; i < 12; i++) fs.rmSync(appFile(`f${i}.ts`));

    let res = await collectAppOpFiles(home, appId);
    expect(deletesIn(res.files)).toEqual([]);
    expect(res.heldDeletes).toHaveLength(12);
    const panel = await listLocalCodeChanges(home, appId);
    expect(panel.changes.filter((c) => c.needsConfirm)).toHaveLength(12);

    const removable = await listRemovableWebPaths(home, appId);
    await approveSyncDeletes(appId, [...removable].map(([p, o]) => ({ path: p, oid: o })));
    res = await collectAppOpFiles(home, appId);
    expect(deletesIn(res.files)).toHaveLength(12);
    expect(res.heldDeletes).toEqual([]);
  });

  it("'Remove from web' for a web-only file sends a delete guarded by the web's OID", async () => {
    await synced({ "index.html": "<html/>" });
    await applyAckedBlobOids(appId, [{ path: "stale.sql", blobOid: "web-oid" }]);
    await approveSyncDeletes(appId, [{ path: "stale.sql", oid: "web-oid" }]);
    const { files } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files)).toEqual([{ path: "stale.sql", content: null, parentHash: "web-oid" }]);
  });

  it("db sidecars on the web are never planned as deletes (writer rejects the whole op)", async () => {
    await synced({ "index.html": "<html/>" });
    await applyAckedBlobOids(appId, [{ path: "jobs/j1/data/data.db-shm", blobOid: "o" }]);
    await updateSyncManifest(appId, { add: [{ path: "jobs/j1/data/data.db-shm", oid: "o" }] });
    const { files } = await collectAppOpFiles(home, appId);
    expect(deletesIn(files)).toEqual([]);
    expect((await listLocalCodeChanges(home, appId)).webOnly).toEqual([]);
  });

  it("panel 'removed' list and publish agree", async () => {
    await synced({ "index.html": "<html/>", "a.ts": "a", "b.ts": "b" });
    fs.rmSync(appFile("a.ts"));
    const panel = (await listLocalCodeChanges(home, appId)).changes.filter((c) => c.change === "removed");
    const { files } = await collectAppOpFiles(home, appId);
    expect(panel.map((c) => c.path)).toEqual(deletesIn(files).map((f) => f.path));
  });

  it("after the delete is acked, the path leaves both cache and manifest", async () => {
    await synced({ "index.html": "<html/>", "a.ts": "a" });
    await removeCachedPaths(appId, ["a.ts"]);
    await updateSyncManifest(appId, { remove: ["a.ts"] });
    expect(Object.keys((await readOidCache()).apps[appId] ?? {})).toEqual(["index.html"]);
    expect([...(await readSyncManifest(appId)).files.keys()]).toEqual(["index.html"]);
  });
});

describe("pull: user 1 deletes, user 2 receives", () => {
  it("round trip: deleted on the web, unchanged here → removed here; edited here → conflict", async () => {
    // user 2 last synced a.ts, b.ts, c.ts
    await synced({ "index.html": "<html/>", "a.ts": "a", "b.ts": "b", "c.ts": "c" });
    fs.writeFileSync(appFile("b.ts"), "b edited on user 2");
    fs.rmSync(appFile("c.ts")); // user 2 also deleted c.ts
    // user 1 deleted a.ts, b.ts and c.ts on the web
    const plan = await planRemoteDeletes({
      paprDir: home,
      appId,
      manifest: await readSyncManifest(appId),
      remotePaths: new Set(["index.html"]),
    });
    expect(plan).toEqual([
      { action: "delete", filePath: "a.ts" },
      { action: "delete_conflict", filePath: "b.ts" },
      { action: "forget", filePath: "c.ts" },
    ]);
  });

  it("never treats web files user 2 never synced as deletions", async () => {
    await synced({ "index.html": "<html/>" });
    write("local-only.ts", "mine"); // never published
    const plan = await planRemoteDeletes({
      paprDir: home,
      appId,
      manifest: await readSyncManifest(appId),
      remotePaths: new Set(["index.html"]),
    });
    expect(plan).toEqual([]);
  });

  it("schema migrations deleted on the web are forgotten, never removed locally", async () => {
    await updateSyncManifest(appId, { add: [{ path: "databases/x/migrations/0001.sql", oid: "o" }] });
    const plan = await planRemoteDeletes({
      paprDir: home,
      appId,
      manifest: await readSyncManifest(appId),
      remotePaths: new Set(["index.html"]),
    });
    expect(plan).toEqual([{ action: "forget", filePath: "databases/x/migrations/0001.sql" }]);
  });
});

describe("unsyncable-file report", () => {
  it("does not report database files or their sidecars", async () => {
    for (const f of ["data.db", "data.db-shm", "data.db-wal", "x.db-journal", "x.db-changes", "x.db-info", "jobs/j/data/data.db-shm"]) {
      write(f, "sqlite");
    }
    expect(await listOversizedFilesInAppDir(path.join(home, "apps", appId))).toEqual([]);
    expect(await buildOversizedAppFilesReport(home, appId)).toBeNull();
  });

  it("classifies an oversized file and a media file separately", async () => {
    write("huge.txt", "a".repeat(11 * 1024 * 1024));
    write("demo.mov", "video");
    const report = await buildOversizedAppFilesReport(home, appId);
    const kinds = Object.fromEntries((report?.paths ?? []).map((p) => [p.path, p.kind]));
    expect(kinds).toEqual({ "huge.txt": "oversized", "demo.mov": "untracked-media" });
    expect(report?.summary).toMatch(/1 over .*MB/);
  });

  it("summarizes by what is actually present", () => {
    const base = { sizeBytes: 1, reason: "over 10 MB" };
    expect(summarizeUnsyncable([{ ...base, path: "a", kind: "oversized" }, { ...base, path: "b", kind: "oversized" }])).toBe("2 over 10 MB");
    expect(summarizeUnsyncable([{ ...base, path: "a", kind: "untracked-media", reason: "m" }])).toBe("1 media/archive file");
  });
});
