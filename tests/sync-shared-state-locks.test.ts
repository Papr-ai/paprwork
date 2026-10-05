import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Parallel publishes share a handful of JSON files. Each read-modify-write
 * must be serialized, otherwise one app's update silently erases another's.
 */
describe("shared sync state under parallel publishes", () => {
  let home: string;
  const prevRoot = process.env.PAPR_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "papr-locks-"));
    process.env.PAPR_HOME = home;
    fs.mkdirSync(path.join(home, "data"), { recursive: true });
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.PAPR_HOME;
    else process.env.PAPR_HOME = prevRoot;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("OID cache keeps every app's acked OIDs when 10 apps ack at once", async () => {
    const { applyAckedBlobOids, readOidCache } = await import(
      "../src/gateway/services/syncV3/OidCache.js"
    );
    const apps = Array.from({ length: 10 }, (_, i) => `app-${i}`);
    await Promise.all(
      apps.map((appId) =>
        applyAckedBlobOids(appId, [
          { path: "index.html", blobOid: `oid-${appId}` },
          { path: "app.ts", blobOid: `ts-${appId}` },
        ]),
      ),
    );
    const cache = await readOidCache();
    for (const appId of apps) {
      expect(cache.apps[appId]?.["index.html"]).toBe(`oid-${appId}`);
      expect(cache.apps[appId]?.["app.ts"]).toBe(`ts-${appId}`);
    }
  });

  it("outbox keeps every entry when 10 apps append and ack concurrently", async () => {
    const outbox = await import("../src/gateway/services/syncV3/SyncOutbox.js");
    await outbox.clearSyncOutboxForTests();
    const apps = Array.from({ length: 10 }, (_, i) => `app-${i}`);
    const entries = await Promise.all(
      apps.map((appId) =>
        outbox.appendOutboxEntry({
          appId,
          files: [{ path: "index.html", content: appId, parentHash: "" }],
          author: "t",
          message: "m",
        }),
      ),
    );
    expect((await outbox.listOutboxEntries()).length).toBe(10);
    await Promise.all(entries.slice(0, 5).map((e) => outbox.markOutboxInflight(e.id)));
    await Promise.all(entries.slice(0, 5).map((e) => outbox.markOutboxAcked(e.id, "sha")));
    const remaining = await outbox.listOutboxEntries();
    expect(remaining.map((e) => e.appId).sort()).toEqual(apps.slice(5).sort());
  });

  it("commit cursors keep every app when written concurrently", async () => {
    const fanout = await import(
      "../src/gateway/services/syncV3/appRepoCommittedFanout.js"
    );
    const apps = Array.from({ length: 10 }, (_, i) => `app-${i}`);
    await Promise.all(apps.map((appId) => fanout.writeAppRepoCommitCursor(appId, `sha-${appId}`)));
    const cursors = await fanout.readAppRepoCommitCursors();
    for (const appId of apps) {
      expect(cursors[appId]?.lastCommitSha).toBe(`sha-${appId}`);
    }
  });
});
