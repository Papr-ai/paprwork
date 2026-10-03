/**
 * Regression: after publish, a file re-saved with identical bytes (e.g. the
 * sharing allowlist) bumped the folder mtime hash and the share bar showed
 * "Unpublished changes" with nothing to publish.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";

const oids: Record<string, Record<string, string>> = {};
vi.mock("../src/gateway/services/syncV3/OidCache.js", () => ({
  readOidCache: vi.fn(async () => ({ version: 1, updatedAt: "", apps: oids })),
}));

import { SyncStateManager } from "../src/gateway/services/cloudSync/syncState.js";
import { computeBlobOidForContent } from "../src/gateway/services/syncV3/computeParentHash.js";
import {
  confirmAppUnchangedSinceUpload,
} from "../src/gateway/services/syncV3/confirmAppUnchangedSinceUpload.js";

const APP = "app-1";
const REL = `apps/${APP}`;

describe("confirmAppUnchangedSinceUpload", () => {
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
  const touch = (rel: string) => {
    const t = new Date();
    fs.utimesSync(path.join(appDir, rel), t, t);
  };

  /** Simulate a publish: record uploaded OIDs and mark the folder synced. */
  const publish = async (files: Record<string, string>) => {
    oids[APP] = {};
    for (const [p, c] of Object.entries(files)) {
      oids[APP][p] = await computeBlobOidForContent(c);
    }
    sm.markSynced(REL);
  };

  const check = () =>
    confirmAppUnchangedSinceUpload(paprDir, APP, sm, sm.computeContentHash(REL));

  beforeEach(async () => {
    paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "unpub-"));
    appDir = path.join(paprDir, REL);
    sm = new SyncStateManager(paprDir);
    write("app.ts", "console.info(1)\n", 60_000);
    write("data/share-people-allowlist.json", "{}\n", 60_000);
    await publish({ "app.ts": "console.info(1)\n", "data/share-people-allowlist.json": "{}\n" });
  });
  afterEach(() => fs.rmSync(paprDir, { recursive: true, force: true }));

  it("identical re-save is not a change, and re-baselines the cheap hash", async () => {
    touch("data/share-people-allowlist.json");
    expect(sm.hasItemChanged(REL)).toBe(true);
    expect(await check()).toBe(true);
    expect(sm.hasItemChanged(REL)).toBe(false);
  });

  it("a real edit is a change", async () => {
    write("app.ts", "console.info(2)\n");
    expect(await check()).toBe(false);
    expect(sm.hasItemChanged(REL)).toBe(true);
  });

  it("a same-size edit is a change", async () => {
    write("app.ts", "console.info(9)\n");
    expect(await check()).toBe(false);
  });

  it("a new file is a change", async () => {
    write("extra.ts", "x\n");
    expect(await check()).toBe(false);
  });

  it("a deleted file is a change", async () => {
    fs.rmSync(path.join(appDir, "app.ts"));
    expect(await check()).toBe(false);
  });

  it("an edit that changes size is decided without reading any file", async () => {
    write("app.ts", "console.info(123456)\n");
    const spy = vi.spyOn(fsp, "readFile");
    expect(await check()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a rename with preserved mtime plus an identical re-save is a change", async () => {
    fs.renameSync(path.join(appDir, "app.ts"), path.join(appDir, "main.ts"));
    touch("data/share-people-allowlist.json");
    expect(await check()).toBe(false);
  });

  it("re-saving a video publish never uploads does not trip the cheap check", () => {
    write("assets/clip.mp4", "fake-video-bytes");
    expect(sm.hasItemChanged(REL)).toBe(false);
  });
});
