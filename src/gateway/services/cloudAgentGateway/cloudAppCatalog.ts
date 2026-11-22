/**
 * The user's published apps, for a cloud workspace run.
 *
 * A cloud workspace session starts with no apps on disk, so `list_apps` came back empty and
 * Pen built a second copy of an app the user already had. In cloud-agent mode, `list_apps`
 * also lists the user's published apps (same records apps.papr.ai and Claude use), and the
 * first time the agent opens one of their own apps its code is cloned into the sandbox, so
 * the normal read/edit tools and the writer push work on the real app.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { getPaprUserId } from "../../utils/paprUserId.js";
import { fetchAppRepoReadCredentials } from "../syncV3/AppRepoClient.js";

const execFileAsync = promisify(execFile);
const CATALOG_TTL_MS = 60_000;

export interface CloudCatalogApp {
  appId: string;
  namespaceId?: string;
  slug?: string;
  shareUrl?: string;
  name?: string | null;
  description?: string | null;
  catalogHeadline?: string | null;
  icon?: string | null;
  visibility?: string;
  publisherUserId?: string | null;
  updatedAt?: string | null;
}

let cache: { userId: string; at: number; apps: CloudCatalogApp[] } | null = null;

/** Own apps + team/public apps in the caller's workspaces (`GET /v1/cloud/apps/accessible`). */
export async function fetchCloudAccessibleApps(): Promise<CloudCatalogApp[]> {
  const userId = getPaprUserId()?.trim() ?? "";
  if (cache && cache.userId === userId && Date.now() - cache.at < CATALOG_TTL_MS) {
    return cache.apps;
  }
  try {
    const resp = await cloudApiFetch("/v1/cloud/apps/accessible", { timeoutMs: 15_000 });
    if (!resp.ok) {
      console.warn(`[CloudAppCatalog] ${resp.status} from /v1/cloud/apps/accessible`);
      return [];
    }
    const body = (await resp.json()) as { apps?: CloudCatalogApp[] };
    const apps = (body.apps ?? []).filter((a) => typeof a?.appId === "string" && a.appId);
    cache = { userId, at: Date.now(), apps };
    return apps;
  } catch (err) {
    console.warn("[CloudAppCatalog] catalog fetch failed:", (err as Error).message);
    return [];
  }
}

/** Their own app (they published it), so the sandbox may load and edit it. */
export function isOwnCatalogApp(app: CloudCatalogApp, userId = getPaprUserId()?.trim()): boolean {
  return Boolean(userId && app.publisherUserId && app.publisherUserId === userId);
}

async function dirHasContent(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** Clone the app's published code into `appsDir/appId` (no-op when already there). */
export async function cloneCatalogAppIntoSandbox(appsDir: string, appId: string): Promise<boolean> {
  const dest = path.join(appsDir, appId);
  if (await dirHasContent(dest)) return true;
  const creds = await fetchAppRepoReadCredentials(appId);
  if (!creds) return false;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "papr-app-hydrate-"));
  try {
    const url = creds.cloneUrl.replace(
      /^https:\/\//,
      `https://x-access-token:${encodeURIComponent(creds.token)}@`,
    );
    await execFileAsync("git", ["clone", "--depth", "1", url, tmp], { timeout: 120_000 });
    const rel = creds.repoPath && creds.repoPath !== "." ? creds.repoPath : "";
    const src = path.join(tmp, rel);
    if (!src.startsWith(tmp)) return false;
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src)) {
      if (entry === ".git") continue;
      await fs.cp(path.join(src, entry), path.join(dest, entry), { recursive: true });
    }
    console.log(`[CloudAppCatalog] Loaded app ${appId} into the sandbox`);
    return true;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** @internal tests */
export function resetCloudAppCatalogCacheForTests(): void {
  cache = null;
}
