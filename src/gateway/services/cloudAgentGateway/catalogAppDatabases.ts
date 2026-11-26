/**
 * A catalog app loaded mid-run (cloneCatalogAppIntoSandbox) brings code only: its
 * linked databases were not in this run's tursoSources, so every write failed with
 * "Database … is not available in this cloud run". Register each linked database as
 * cloud-direct with a freshly minted token so DB tools and /api/db/* reach the
 * Turso primary, same as databases memory resolved up front.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { cloudApiFetch } from "../../utils/cloudApiClient.js";
import { parseDataSourcesFile } from "../appDataSources.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import { setCloudDirectCredentials } from "../cloudDirect/cloudDirectDb.js";
import { rewritePaprPathForCloudRun } from "./cloudPaprPath.js";
import { dbTursoDatabaseName } from "../tursoDatabaseNaming.js";

interface PortableRecord {
  tursoShortName?: string;
  label?: string;
  isolation?: "shared" | "per-user";
  schemaOwnerAppId?: string;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function mintToken(database: string, appId?: string): Promise<{ url: string; authToken: string }> {
  const res = await cloudApiFetch("/v1/cloud/databases/token", {
    method: "POST",
    body: appId ? { database, appId } : { database },
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { tursoUrl?: string; authToken?: string };
  if (!json.tursoUrl || !json.authToken) throw new Error("token response missing tursoUrl/authToken");
  return { url: json.tursoUrl, authToken: json.authToken };
}

/** Returns the dbIds now reachable. Failures are logged, never thrown (the app still loads). */
export async function registerCatalogAppDatabases(
  paprHome: string,
  appId: string,
): Promise<string[]> {
  const appDir = path.join(paprHome, "apps", appId);
  const raw = await fs.readFile(path.join(appDir, "data-sources.json"), "utf8").catch(() => null);
  if (!raw) return [];
  const linked =
    (await readJson<{ databases?: Record<string, PortableRecord> }>(
      path.join(appDir, "linked-databases.json"),
    ))?.databases ?? {};
  const registry = getDatabaseRegistryService();
  const done: string[] = [];
  for (const source of parseDataSourcesFile(raw).sources) {
    const dbId = source.dbId?.trim();
    if (!dbId) continue;
    const meta = linked[dbId] ?? {};
    // Per-user databases need the caller's suffix; the token route resolves it only
    // through memory's prepare step, so leave those to the next run.
    if (meta.isolation === "per-user") continue;
    const tursoShortName = meta.tursoShortName ?? dbTursoDatabaseName(dbId);
    try {
      const creds = await mintToken(tursoShortName, appId);
      setCloudDirectCredentials(new Map([[tursoShortName, creds]]));
      const existing = registry.getById(dbId);
      if (existing) {
        await registry.assignSyncMode(dbId, "cloud-direct");
      } else {
        await registry.register({
          dbId,
          // Published copies strip paths (dbPath ""). Cloud-direct never opens the
          // file; the path only has to be a valid, unique registry key.
          localPath: source.dbPath
            ? rewritePaprPathForCloudRun(source.dbPath, paprHome)
            : path.join(paprHome, "data", "databases", dbId, "data.db"),
          tursoShortName,
          label: meta.label ?? source.alias ?? dbId,
          isolation: "shared",
          schemaOwnerAppId: meta.schemaOwnerAppId ?? appId,
          syncMode: "cloud-direct",
        });
      }
      done.push(dbId);
    } catch (err) {
      console.warn(
        `[CloudAppCatalog] Database ${dbId} for app ${appId} not reachable: ${(err as Error).message}`,
      );
    }
  }
  if (done.length) console.log(`[CloudAppCatalog] Connected ${appId} databases: ${done.join(", ")}`);
  return done;
}
