/**
 * Dirty flag for "Unpublished changes": set on edit (only when content really
 * differs from the last upload), cleared on publish, O(1) status reads.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oids: Record<string, Record<string, string>> = {};
vi.mock("../src/gateway/services/syncV3/OidCache.js", () => ({
  readOidCache: vi.fn(async () => ({ version: 1, updatedAt: "", apps: oids })),
}));
const stale = vi.fn();
vi.mock("../src/gateway/services/cloudSync/cloudSyncBroadcast.js", () => ({
  notifyCloudSyncItemsStale: (id?: string) => stale(id),
}));

import { SyncStateManager } from "../src/gateway/services/cloudSync/syncState.js";
import { computeBlobOidForContent } from "../src/gateway/services/syncV3/computeParentHash.js";
import {
  flushAppDirtyForTests,
  isAppDirty,
  markAppPublished,
  noteAppPathEdited,
  resetAppDirtyStateForTests,
  setAppEditTrackingActive,
} from "../src/gateway/services/syncV3/appDirtyState.js";

const APP = "app-1";
const REL = `apps/${APP}`;

describe("appDirtyState", () => {
  let paprDir: string;
  let appDir: string;
  let sm: SyncStateManager;

  const write = (rel: string, content: string, ageMs = 0) => {
    const full = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(full, t, t);
    }
  };
  /** Simulate a successful publish of the current folder. */
  const publish = async () => {
    oids[APP] = {};
    const walk = (dir: string, prefix: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (!rel.endsWith(".mp4")) oids[APP][rel] = fs.readFileSync(path.join(dir, e.name), "utf8");
      }
    };
    walk(appDir, "");
    for (const [p, c] of Object.entries(oids[APP])) oids[APP][p] = await computeBlobOidForContent(c);
    sm.markSynced(REL);
    await markAppPublished(paprDir, APP);
  };
  const edit = async (rel: string, content?: string) => {
    if (content === undefined) fs.rmSync(path.join(appDir, rel));
    else write(rel, content);
    noteAppPathEdited(paprDir, APP, rel);
    await flushAppDirtyForTests(paprDir, APP);
  };
  const dirty = () => isAppDirty(paprDir, APP, sm);

  beforeEach(async () => {
    paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirty-"));
    appDir = path.join(paprDir, REL);
    sm = new SyncStateManager(paprDir);
    resetAppDirtyStateForTests();
    stale.mockClear();
    write("app.ts", "console.info(1)\n", 60_000);
    write("data/share-people-allowlist.json", "{}\n", 60_000);
    setAppEditTrackingActive(true);
    await publish();
  });
  afterEach(() => fs.rmSync(paprDir, { recursive: true, force: true }));

  it("starts clean after publish", async () => {
    expect(await dirty()).toBe(false);
  });

  it("identical re-save leaves the flag clear", async () => {
    await edit("data/share-people-allowlist.json", "{}\n");
    expect(await dirty()).toBe(false);
  });

  it("a real edit sets it and publish clears it", async () => {
    await edit("app.ts", "console.info(2)\n");
    expect(await dirty()).toBe(true);
    expect(stale).toHaveBeenCalledWith(APP);
    await publish();
    expect(await dirty()).toBe(false);
  });

  it("editing back to the published content clears it without a publish", async () => {
    await edit("app.ts", "console.info(2)\n");
    await edit("app.ts", "console.info(1)\n");
    expect(await dirty()).toBe(false);
  });

  it("a data/ edit sets it", async () => {
    await edit("data/share-people-allowlist.json", '{"a":1}\n');
    expect(await dirty()).toBe(true);
  });

  it("records every file in a burst, not just the last", async () => {
    write("app.ts", "console.info(2)\n");
    noteAppPathEdited(paprDir, APP, "app.ts");
    write("data/share-people-allowlist.json", "{}\n");
    noteAppPathEdited(paprDir, APP, "data/share-people-allowlist.json");
    await flushAppDirtyForTests(paprDir, APP);
    expect(await dirty()).toBe(true);
  });

  it("new and deleted files set it", async () => {
    await edit("extra.ts", "x\n");
    expect(await dirty()).toBe(true);
    await publish();
    await edit("extra.ts");
    expect(await dirty()).toBe(true);
  });

  it("ignores files publish never uploads", async () => {
    await edit("assets/clip.mp4", "bytes");
    expect(await dirty()).toBe(false);
  });

  it("catches edits made while the watcher was off (startup reconcile)", async () => {
    setAppEditTrackingActive(false);
    write("app.ts", "console.info(offline)\n");
    setAppEditTrackingActive(true);
    expect(await dirty()).toBe(true);
  });

  it("startup reconcile ignores an identical re-save", async () => {
    setAppEditTrackingActive(false);
    write("data/share-people-allowlist.json", "{}\n");
    setAppEditTrackingActive(true);
    expect(await dirty()).toBe(false);
  });

  it("without a watcher every read reconciles from disk", async () => {
    setAppEditTrackingActive(false);
    write("app.ts", "console.info(3)\n");
    expect(await dirty()).toBe(true);
  });
});
