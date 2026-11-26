/**
 * Live code copy: the app's code as the web last had it, kept per app at
 * data/live-code/{appId}/. The Live view serves it; Preview serves the app
 * folder (your edits). Code only — no databases or uploads.
 *
 * Written whenever this computer learns what the web has:
 *  - Get updates / pull (the cloned HEAD files)
 *  - a copy's track sync (the publisher's files)
 *  - publish ack (local files whose bytes match the acked OIDs)
 * Never edited by Pen, never synced, safe to delete (rebuilt on the next one).
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";

/** Paths that live outside the app folder (job + schema files) are not app code. */
function isAppCodePath(rel: string): boolean {
  const first = rel.split("/")[0];
  return first !== "jobs" && first !== "databases" && !rel.startsWith(".") && rel !== "papr-cloud-lineage.json";
}

export function liveCodeRoot(paprRoot = getPaprRoot()): string {
  return path.join(paprRoot, "data", "live-code");
}

export function liveCodeDir(appId: string, paprRoot = getPaprRoot()): string {
  return path.join(liveCodeRoot(paprRoot), appId);
}

export function gitBlobOid(buf: Buffer): string {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function go(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await go(full);
      else if (e.isFile()) out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
  await go(root);
  return out;
}

const chains = new Map<string, Promise<unknown>>();
/** One writer per app at a time; later calls wait for earlier ones. */
function serial<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(appId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(appId, next);
  // .catch: the finally() promise re-rejects; the caller handles `next` itself.
  next
    .finally(() => {
      if (chains.get(appId) === next) chains.delete(appId);
    })
    .catch(() => undefined);
  return next;
}

/** Swap in a complete new tree; readers see the old or the new copy, never half. */
async function writeTree(appId: string, files: Map<string, Buffer>, paprRoot: string): Promise<void> {
  const dir = liveCodeDir(appId, paprRoot);
  const stage = `${dir}.tmp-${randomBytes(4).toString("hex")}`;
  await fs.mkdir(stage, { recursive: true });
  try {
    for (const [rel, buf] of files) {
      const full = path.join(stage, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buf);
    }
    const hasEntry = ["app.ts", "app.tsx", "main.ts", "main.tsx"].some((f) => files.has(f));
    if (hasEntry && !files.has("dist/app.js")) {
      const { buildMiniApp } = await import("../../utils/miniAppBuild.js");
      const built = await buildMiniApp(stage);
      if (!built.success) {
        console.warn(`[LiveCode] ${appId}: Live build failed, keeping the previous copy`);
        throw new Error("live build failed");
      }
    }
    const trash = `${dir}.old-${randomBytes(4).toString("hex")}`;
    await fs.rename(dir, trash).catch(() => undefined);
    await fs.rename(stage, dir);
    await fs.rm(trash, { recursive: true, force: true });
  } catch (err) {
    await fs.rm(stage, { recursive: true, force: true });
    throw err;
  }
}

/** Live = exactly these files (the web's HEAD, or the publisher's for a copy). */
export function writeLiveCode(
  appId: string,
  files: ReadonlyMap<string, string | Buffer>,
  paprRoot = getPaprRoot(),
): Promise<void> {
  return serial(appId, async () => {
    const tree = new Map<string, Buffer>();
    for (const [rel, c] of files) {
      if (isAppCodePath(rel)) tree.set(rel, typeof c === "string" ? Buffer.from(c, "utf8") : c);
    }
    if (tree.size === 0) return;
    await writeTree(appId, tree, paprRoot);
  });
}

/**
 * Rebuild Live from what we know the web holds (path → hash). Each path takes
 * the app folder's bytes when they match, else the current Live copy's.
 * Returns paths neither had (Live lags on those until the next pull).
 */
export function reconcileLiveCode(
  appId: string,
  expected: Readonly<Record<string, string>>,
  hash: (buf: Buffer) => string,
  paprRoot = getPaprRoot(),
): Promise<{ missing: string[] }> {
  return serial(appId, async () => {
    const appDir = path.join(paprRoot, "apps", appId);
    const liveDir = liveCodeDir(appId, paprRoot);
    const tree = new Map<string, Buffer>();
    const missing: string[] = [];
    for (const [rel, want] of Object.entries(expected)) {
      if (!isAppCodePath(rel)) continue;
      let hit: Buffer | null = null;
      for (const root of [appDir, liveDir]) {
        const buf = await fs.readFile(path.join(root, rel)).catch(() => null);
        if (buf && hash(buf) === want) {
          hit = buf;
          break;
        }
      }
      if (hit) tree.set(rel, hit);
      else missing.push(rel);
    }
    if (tree.size > 0) await writeTree(appId, tree, paprRoot);
    return { missing };
  });
}

/** Owner side: after a publish ack, Live = the acked OIDs. */
export async function refreshLiveCodeFromOidCache(appId: string): Promise<void> {
  const { readOidCache } = await import("../syncV3/OidCache.js");
  const oids = (await readOidCache()).apps[appId] ?? {};
  if (Object.keys(oids).length === 0) return;
  const { missing } = await reconcileLiveCode(appId, oids, gitBlobOid);
  if (missing.length > 0) {
    console.log(`[LiveCode] ${appId}: ${missing.length} path(s) not on this computer yet; Live updates on the next pull`);
  }
}

/** Never throws: Live lagging must never fail a publish or a pull. */
export function refreshLiveCodeQuietly(label: string, fn: () => Promise<unknown>): void {
  void fn().catch((err: unknown) => {
    console.warn(`[LiveCode] ${label} skipped:`, err instanceof Error ? err.message : err);
  });
}

export async function hasLiveCode(appId: string, paprRoot = getPaprRoot()): Promise<boolean> {
  return (await fs.stat(path.join(liveCodeDir(appId, paprRoot), "index.html")).catch(() => null)) !== null;
}

export async function removeLiveCode(appId: string, paprRoot = getPaprRoot()): Promise<void> {
  await fs.rm(liveCodeDir(appId, paprRoot), { recursive: true, force: true });
}

export { walk as listLiveFilesForTests };

const seeded = new Set<string>();
/**
 * Apps published before Live copies existed: build one from what we already
 * know (owner: OID cache; copy: the lineage's sync snapshot). Once per run.
 */
export async function seedLiveCodeIfMissing(appId: string, paprRoot = getPaprRoot()): Promise<void> {
  if (seeded.has(appId) || (await hasLiveCode(appId, paprRoot))) return;
  seeded.add(appId);
  const lineageRaw = await fs
    .readFile(path.join(paprRoot, "apps", appId, "papr-cloud-lineage.json"), "utf8")
    .catch(() => null);
  if (lineageRaw) {
    const { parseCloudAppLineageFile } = await import("../../../core/utils/cloudAppLineage.js");
    const lineage = parseCloudAppLineageFile(lineageRaw);
    if (lineage?.mode === "track" && lineage.syncSnapshot) {
      await reconcileLiveCode(appId, lineage.syncSnapshot, sha256Hex, paprRoot);
      return;
    }
  }
  await refreshLiveCodeFromOidCache(appId);
}
