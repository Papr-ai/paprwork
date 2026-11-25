import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  gitBlobOid,
  hasLiveCode,
  liveCodeDir,
  reconcileLiveCode,
  removeLiveCode,
  sha256Hex,
  writeLiveCode,
} from "./liveCodeCopy.js";
import { resolveLiveServe } from "./liveCodeServe.js";

const APP = "app-live-1";

describe("Live code copy", () => {
  let root: string;
  let appDir: string;
  const writeApp = (rel: string, body: string) => {
    const full = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  const readLive = (rel: string) => fs.readFileSync(path.join(liveCodeDir(APP, root), rel), "utf8");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "live-code-"));
    appDir = path.join(root, "apps", APP);
    fs.mkdirSync(appDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes the web's files and leaves out job, schema and lineage files", async () => {
    await writeLiveCode(
      APP,
      new Map([
        ["index.html", "<p>web</p>"],
        ["style.css", "p{}"],
        ["jobs/j1/run.py", "print()"],
        ["databases/d/migrations/0001.sql", "create table t(x);"],
        ["papr-cloud-lineage.json", "{}"],
      ]),
      root,
    );
    expect(readLive("index.html")).toBe("<p>web</p>");
    expect(readLive("style.css")).toBe("p{}");
    expect(fs.existsSync(path.join(liveCodeDir(APP, root), "jobs"))).toBe(false);
    expect(fs.existsSync(path.join(liveCodeDir(APP, root), "databases"))).toBe(false);
    expect(fs.existsSync(path.join(liveCodeDir(APP, root), "papr-cloud-lineage.json"))).toBe(false);
  });

  it("replaces the whole copy, so files the web removed are gone from Live", async () => {
    await writeLiveCode(APP, new Map([["index.html", "a"], ["old.ts", "x"]]), root);
    await writeLiveCode(APP, new Map([["index.html", "b"]]), root);
    expect(readLive("index.html")).toBe("b");
    expect(fs.existsSync(path.join(liveCodeDir(APP, root), "old.ts"))).toBe(false);
  });

  it("publish: takes folder bytes that match the acked OIDs, keeps Live for the rest", async () => {
    await writeLiveCode(APP, new Map([["index.html", "v1"], ["a.css", "old"]]), root);
    writeApp("index.html", "v2"); // published now
    writeApp("a.css", "edited after publish"); // not what the web has
    const { missing } = await reconcileLiveCode(
      APP,
      { "index.html": gitBlobOid(Buffer.from("v2")), "a.css": gitBlobOid(Buffer.from("old")) },
      gitBlobOid,
      root,
    );
    expect(missing).toEqual([]);
    expect(readLive("index.html")).toBe("v2");
    expect(readLive("a.css")).toBe("old");
  });

  it("reports paths neither the folder nor Live has, without dropping the rest", async () => {
    writeApp("index.html", "here");
    const { missing } = await reconcileLiveCode(
      APP,
      { "index.html": sha256Hex(Buffer.from("here")), "x.ts": sha256Hex(Buffer.from("nowhere")) },
      sha256Hex,
      root,
    );
    expect(missing).toEqual(["x.ts"]);
    expect(readLive("index.html")).toBe("here");
  });

  it("concurrent writes settle on the last one", async () => {
    await Promise.all([
      writeLiveCode(APP, new Map([["index.html", "1"]]), root),
      writeLiveCode(APP, new Map([["index.html", "2"]]), root),
      writeLiveCode(APP, new Map([["index.html", "3"]]), root),
    ]);
    expect(readLive("index.html")).toBe("3");
    const leftovers = fs.readdirSync(path.join(root, "data", "live-code")).filter((n) => n !== APP);
    expect(leftovers).toEqual([]);
  });

  it("builds dist/ for a TypeScript app", async () => {
    await writeLiveCode(
      APP,
      new Map([
        ["index.html", '<script type="module" src="app.ts"></script>'],
        ["app.ts", "document.body.textContent = 'live';"],
      ]),
      root,
    );
    expect(readLive("dist/app.js")).toContain("live");
  });

  it("removeLiveCode deletes the copy", async () => {
    await writeLiveCode(APP, new Map([["index.html", "a"]]), root);
    expect(await hasLiveCode(APP, root)).toBe(true);
    await removeLiveCode(APP, root);
    expect(await hasLiveCode(APP, root)).toBe(false);
  });
});

describe("resolveLiveServe", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "live-serve-"));
    fs.mkdirSync(path.join(root, "apps", APP), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("no @live prefix: the app folder (Preview)", async () => {
    const r = await resolveLiveServe(APP, "dist/app.js", root);
    expect(r).toMatchObject({ path: "dist/app.js", dir: null });
  });

  it("@live with no copy yet: falls back to the app folder", async () => {
    const r = await resolveLiveServe(APP, "@live/index.html", root);
    expect(r).toMatchObject({ path: "index.html", dir: null });
  });

  it("@live with a copy: serves from it, and refuses paths outside it", async () => {
    await writeLiveCode(APP, new Map([["index.html", "a"], ["dist/app.js", "x"]]), root);
    const r = await resolveLiveServe(APP, "@live/dist/app.js", root);
    expect(r.dir).toBe(liveCodeDir(APP, root));
    expect(await r.resolve("dist/app.js")).toBe(path.join(liveCodeDir(APP, root), "dist", "app.js"));
    expect(await r.resolve("../../apps/x")).toBeNull();
    expect(await r.resolve("missing.css")).toBeNull();
    expect((await resolveLiveServe(APP, "@live", root)).path).toBe("index.html");
  });
});
