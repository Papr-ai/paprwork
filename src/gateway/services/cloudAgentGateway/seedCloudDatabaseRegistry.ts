/**
 * Cloud agent sandbox: the job's registry databases live in Papr Cloud, not on disk.
 *
 * With Turso-direct on, the sandbox does not pull a local copy. Instead every
 * database memory minted creds for (tursoSources) is registered as
 * syncMode "cloud-direct" — the same mode no-engine desktops use — and its creds
 * are handed to cloudDirectDb. From there the existing cloud-direct routing
 * (DbRouter, papr_db_exec, migrations) reads and writes the Turso primary directly.
 *
 * Also fills in records missing from app-scoped workspaces, which only receive
 * data/apps.json + data/jobs.json from memory's scaffold (no data/databases.json).
 */

import fs from "fs/promises";
import path from "path";
import { rewritePaprPathForCloudRun } from "./cloudPaprPath.js";
import { setCloudDirectCredentials } from "../cloudDirect/cloudDirectDb.js";
import type { CloudAgentRunRequest } from "./types.js";

export async function seedCloudDatabaseRegistry(
  request: Pick<CloudAgentRunRequest, "tursoSources" | "linkedSources" | "appId">,
  paprHome: string,
  options: { cloudDirect: boolean },
): Promise<string[]> {
  const sources = (request.tursoSources ?? []).filter((s) => s.syncKey?.startsWith("db-"));
  if (sources.length === 0) return [];

  const registryPath = path.join(paprHome, "data", "databases.json");
  let registry: { version: 1; databases: Record<string, Record<string, unknown>> } = {
    version: 1,
    databases: {},
  };
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8"));
    if (parsed?.databases && typeof parsed.databases === "object") registry = parsed;
  } catch {
    /* no registry in app-scoped workspace — expected */
  }

  const now = new Date().toISOString();
  const touched: string[] = [];
  for (const source of sources) {
    const dbId = source.syncKey;
    const existing = registry.databases[dbId];
    if (existing && !options.cloudDirect) continue;
    const linked = (request.linkedSources ?? []).find((l) => l.dbId === dbId);
    registry.databases[dbId] = {
      dbId,
      localPath: rewritePaprPathForCloudRun(source.dbPath, paprHome),
      label: linked?.alias || dbId,
      isolation: linked?.isolation ?? "shared",
      status: "active",
      ...(request.appId ? { schemaOwnerAppId: request.appId } : {}),
      createdAt: now,
      ...existing,
      // Memory resolved the exact Turso database (incl. per-user suffix) — use it verbatim.
      tursoShortName: source.databaseShortName,
      syncMode: options.cloudDirect ? "cloud-direct" : (existing?.syncMode ?? "replica"),
      updatedAt: now,
    };
    touched.push(dbId);
  }

  if (options.cloudDirect) {
    setCloudDirectCredentials(
      new Map(
        sources.map((s) => [s.databaseShortName, { url: s.databaseUrl, authToken: s.authToken }]),
      ),
    );
  }

  if (touched.length > 0) {
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");
    console.log(
      `[CloudAgentRun] Registered ${options.cloudDirect ? "cloud-direct" : "replica"} databases: ${touched.join(", ")}`,
    );
  }
  return touched;
}
