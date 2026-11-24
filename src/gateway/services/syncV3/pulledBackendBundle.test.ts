import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptPulledBackendBundle } from "./pulledBackendBundle.js";

const MANIFEST = JSON.stringify({ version: 1, actions: { ping: { handler: "ping.py", runtime: "python" } } });
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const bundleFor = (handler: string, builtAt = "2026-11-12T00:00:00Z") =>
  `${JSON.stringify({ version: 1, builtAt, actions: { ping: { handler: "ping.py", sha256: sha(handler), bytes: handler.length } } }, null, 2)}\n`;

let appDir: string;
let srcDir: string;
const put = async (root: string, rel: string, c: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), c);
};
const read = (rel: string) => fs.readFile(path.join(appDir, rel), "utf8");

beforeEach(async () => {
  appDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-app-"));
  srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-src-"));
  await put(appDir, "backend/manifest.json", MANIFEST);
  await put(appDir, "backend/bundle.json", bundleFor("old", "2026-11-01T00:00:00Z"));
  await put(appDir, ".papr-cloud-revision", "fa31182d00000000\n");
  await put(srcDir, ".papr-cloud-revision", "25b381d200000000\n");
});
afterEach(async () => {
  await fs.rm(appDir, { recursive: true, force: true });
  await fs.rm(srcDir, { recursive: true, force: true });
});

describe("adoptPulledBackendBundle", () => {
  it("pulled handler matches the web's bundle: takes the web's bundle and revision", async () => {
    await put(appDir, "backend/ping.py", "new");
    const web = bundleFor("new");
    const adopted = await adoptPulledBackendBundle(appDir, new Map([["backend/bundle.json", web]]), srcDir);
    expect(adopted).toEqual(["backend/bundle.json", ".papr-cloud-revision"]);
    expect(await read("backend/bundle.json")).toBe(web);
    expect(await read(".papr-cloud-revision")).toBe("25b381d200000000\n");
  });

  it("a local handler edit the web doesn't have: leaves both alone (real change to publish)", async () => {
    await put(appDir, "backend/ping.py", "mine");
    const adopted = await adoptPulledBackendBundle(appDir, new Map([["backend/bundle.json", bundleFor("new")]]), srcDir);
    expect(adopted).toEqual([]);
    expect(await read("backend/bundle.json")).toBe(bundleFor("old", "2026-11-01T00:00:00Z"));
    expect(await read(".papr-cloud-revision")).toBe("fa31182d00000000\n");
  });

  it("no backend on the web, or already identical: nothing to do", async () => {
    await put(appDir, "backend/ping.py", "new");
    expect(await adoptPulledBackendBundle(appDir, new Map(), srcDir)).toEqual([]);
    await put(appDir, "backend/bundle.json", bundleFor("new"));
    await put(appDir, ".papr-cloud-revision", "25b381d200000000\n");
    expect(await adoptPulledBackendBundle(appDir, new Map([["backend/bundle.json", bundleFor("new")]]), srcDir)).toEqual([]);
  });

  it("unreadable web bundle or missing handler: skips safely", async () => {
    expect(await adoptPulledBackendBundle(appDir, new Map([["backend/bundle.json", "{oops"]]), srcDir)).toEqual([]);
    expect(await adoptPulledBackendBundle(appDir, new Map([["backend/bundle.json", bundleFor("new")]]), srcDir)).toEqual([]);
  });
});
