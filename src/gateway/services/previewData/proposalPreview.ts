/**
 * Try one proposal (plan 8d). A reviewer's view of a proposal is:
 *  - code: the Live copy + only the files that proposal changed (never mixed
 *    with your own edits or another proposal), in its own folder;
 *  - data: always a test copy (schema + up to 100 rows) with the proposal's
 *    migrations applied, so trying a proposal never touches the team's data.
 * Served at /apps/{appId}/@pr-{requestId}/... ; thrown away when you leave
 * (removeProposalPreview) or when the app is deleted.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AppDataSource } from "../appDataSources.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { liveCodeDir } from "../liveCode/liveCodeCopy.js";

export const PR_PREFIX = "@pr-";
const ID_RE = /^[0-9a-zA-Z-]{6,64}$/;

export function proposalPreviewDir(appId: string, requestId: string, paprRoot = getPaprRoot()): string {
  return path.join(paprRoot, "data", "proposal-preview", appId, requestId);
}

/** "@pr-<id>/dist/app.js" → { requestId, rel: "dist/app.js" }. */
export function parseProposalPath(raw: string): { requestId: string; rel: string } | null {
  if (!raw.startsWith(PR_PREFIX)) return null;
  const rest = raw.slice(PR_PREFIX.length);
  const slash = rest.indexOf("/");
  const requestId = slash < 0 ? rest : rest.slice(0, slash);
  if (!ID_RE.test(requestId)) return null;
  return { requestId, rel: (slash < 0 ? "" : rest.slice(slash + 1)) || "index.html" };
}

/** The proposal a request comes from (its frame's URL), if any. */
export function proposalFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    const m = new URL(referer).pathname.match(/\/apps\/[^/]+\/@pr-([^/]+)\//);
    return m && ID_RE.test(m[1]!) ? m[1]! : null;
  } catch {
    return null;
  }
}

export interface ProposalFiles {
  /** Files the proposal adds or changes (repo-relative path → content). */
  changed: Map<string, string>;
  /** Files the proposal removes. */
  removed: string[];
  /** Identifies this version of the proposal (rebuild when it moves). */
  headRef: string;
}

/** What GitHub says the proposal changes, with full file contents. */
export async function fetchProposalFiles(requestId: string): Promise<ProposalFiles> {
  const { buildCloudAppChangeReview, readCloudAppChangeFileAtHead } = await import("../cloudAppChangeGitHubReview.js");
  const review = await buildCloudAppChangeReview({ requestId, maxFiles: 200, maxTotalPatchChars: 1 });
  if (review.diff.filesTruncated) throw new Error("This proposal changes too many files to preview");
  const changed = new Map<string, string>();
  const removed: string[] = [];
  for (const f of review.diff.files) {
    if (f.status === "removed") {
      removed.push(f.path);
      continue;
    }
    const file = await readCloudAppChangeFileAtHead({ requestId, relativePath: f.path, maxChars: 5_000_000 });
    changed.set(f.path, file.content);
  }
  return { changed, removed, headRef: review.diff.headRef };
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true }).catch(() => [])) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b);
    else if (e.isFile()) await fs.copyFile(a, b);
  }
}

const building = new Map<string, Promise<string>>();

/**
 * Build (or reuse) the proposal's code folder: Live + its changes, dist/ rebuilt.
 * Returns the folder. `files` is injectable for tests.
 */
export function ensureProposalPreview(
  appId: string,
  requestId: string,
  opts: { files?: ProposalFiles; paprRoot?: string } = {},
): Promise<string> {
  const key = `${appId}:${requestId}`;
  const running = building.get(key);
  if (running) return running;
  const p = (async () => {
    const paprRoot = opts.paprRoot ?? getPaprRoot();
    const files = opts.files ?? (await fetchProposalFiles(requestId));
    const root = proposalPreviewDir(appId, requestId, paprRoot);
    const stamp = path.join(root, ".head");
    const codeDir = path.join(root, "code");
    if ((await fs.readFile(stamp, "utf8").catch(() => "")) === files.headRef) return codeDir;

    const live = liveCodeDir(appId, paprRoot);
    if (!(await fs.stat(path.join(live, "index.html")).catch(() => null))) {
      throw new Error("No Live copy of this app yet. Open Live once, then try the proposal again.");
    }
    const stage = `${root}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      await copyTree(live, path.join(stage, "code"));
      for (const rel of files.removed) await fs.rm(path.join(stage, "code", rel), { force: true });
      for (const [rel, content] of files.changed) {
        if (rel.split("/")[0] === "jobs" || rel.startsWith(".")) continue;
        const full = path.join(stage, "code", rel);
        if (!full.startsWith(path.join(stage, "code") + path.sep)) continue;
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content);
      }
      // The proposal's own build output can't be trusted to match its source.
      await fs.rm(path.join(stage, "code", "dist"), { recursive: true, force: true });
      const { buildMiniApp } = await import("../../utils/miniAppBuild.js");
      const built = await buildMiniApp(path.join(stage, "code"));
      if (!built.success) {
        const first = built.errors.find((e) => e.severity === "error");
        throw new Error(`This proposal doesn't build: ${first ? `${first.file} ${first.message}` : "unknown error"}`);
      }
      await fs.writeFile(path.join(stage, ".head"), files.headRef);
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(path.dirname(root), { recursive: true });
      await fs.rename(stage, root);
    } catch (err) {
      await fs.rm(stage, { recursive: true, force: true });
      throw err;
    }
    return codeDir;
  })().finally(() => building.delete(key));
  building.set(key, p);
  return p;
}

/**
 * The proposal's data: a test copy of `real` with the proposal's migrations for
 * this database applied (databases/<slug>/migrations/*.sql in its changes).
 * Always a copy, even when the proposal has no migrations.
 */
export async function proposalDataSource(
  appId: string,
  requestId: string,
  real: AppDataSource,
  deps?: {
    read?: (sql: string) => Promise<{ rows: Record<string, unknown>[] } | null>;
    migrationSlug?: string | null;
    paprRoot?: string;
  },
): Promise<AppDataSource & { previewCopy: true }> {
  const paprRoot = deps?.paprRoot ?? getPaprRoot();
  const root = proposalPreviewDir(appId, requestId, paprRoot);
  const codeDir = path.join(root, "code");
  const head = (await fs.readFile(path.join(root, ".head"), "utf8").catch(() => "")) || "none";
  const key = createHash("sha256").update(`${real.dbId ?? real.dbPath}|${head}`).digest("hex").slice(0, 12);
  const file = path.join(root, "data", `${key}.db`);
  const out = { ...real, dbId: undefined, dbPath: file, previewCopy: true as const };
  if (await fs.stat(file).catch(() => null)) return out;

  let read = deps?.read;
  let slug = deps?.migrationSlug;
  if (!read || slug === undefined) {
    const { queryRegistryDatabase } = await import("../jobs/registryDbSchemaReader.js");
    const { resolveMigrationRootFromDbPath } = await import("../jobs/databaseMigrations.js");
    read ??= (sql) => queryRegistryDatabase({ dbPath: real.dbPath, dbId: real.dbId }, sql);
    if (slug === undefined) {
      const mr = resolveMigrationRootFromDbPath(real.dbPath);
      slug = mr ? path.basename(mr) : null;
    }
  }
  const { buildTestCopy, applyMigrationsToTestCopy } = await import("../cloudSync/proposalTestCopy.js");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    await buildTestCopy(read, tmp);
    const migDir = slug ? path.join(codeDir, "databases", slug, "migrations") : null;
    const names = migDir ? (await fs.readdir(migDir).catch(() => [] as string[])).filter((n) => n.endsWith(".sql")).sort() : [];
    const team = await read("SELECT max(id) m FROM _papr_schema_migrations").catch(() => null);
    const teamMax = String(team?.rows[0]?.m ?? "");
    const migrations = [];
    for (const n of names) {
      const id = n.replace(/\.sql$/, "");
      if (id > teamMax) migrations.push({ id, sql: await fs.readFile(path.join(migDir!, n), "utf8") });
    }
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(tmp);
    try {
      const r = applyMigrationsToTestCopy(db, migrations);
      if (r.failed) throw new Error(`This proposal's data change fails on a test copy (${r.failed.id}: ${r.failed.error})`);
    } finally {
      db.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return out;
}

export async function removeProposalPreview(appId: string, requestId?: string, paprRoot = getPaprRoot()): Promise<void> {
  const dir = requestId
    ? proposalPreviewDir(appId, requestId, paprRoot)
    : path.join(paprRoot, "data", "proposal-preview", appId);
  await fs.rm(dir, { recursive: true, force: true });
}
