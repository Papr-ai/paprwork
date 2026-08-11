/**
 * Periodic convergence checker — local vs Turso content digests (SYNC_CONTRACT §10).
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@libsql/client";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import {
  filterSyncableTables,
  listUserTables,
  openWritableLocalJobDb,
} from "../tursoSyncBridgeCore.js";
import { discoverTursoLinkedSources, linkedSourceSyncKey } from "../tursoLinkedSources.js";
import { jobTursoDatabaseName } from "../tursoDatabaseNaming.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import {
  computeLocalTableConvergenceDigest,
  computeRemoteTableConvergenceDigest,
  digestsMatch,
} from "./convergenceHash.js";

export const CONVERGENCE_CHECK_INTERVAL_MS = 5 * 60_000;

export interface SourceConvergenceState {
  syncKey: string;
  appId: string;
  alias: string;
  lastCheckedAt: string | null;
  lastVerifiedAt: string | null;
  ok: boolean;
  driftTables: string[];
  error?: string;
}

export interface ConvergenceStateFile {
  sources: Record<string, SourceConvergenceState>;
}

const CONVERGENCE_STATE_FILENAME = ".turso-convergence-state.json";

function defaultState(): ConvergenceStateFile {
  return { sources: {} };
}

export function resolveConvergenceStatePath(paprDir?: string): string {
  const root = paprDir ?? getPaprRoot();
  return path.join(root, "data", CONVERGENCE_STATE_FILENAME);
}

export function loadConvergenceState(paprDir?: string): ConvergenceStateFile {
  const statePath = resolveConvergenceStatePath(paprDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as ConvergenceStateFile;
    if (parsed?.sources && typeof parsed.sources === "object") {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return defaultState();
}

export function saveConvergenceState(
  state: ConvergenceStateFile,
  paprDir?: string,
): void {
  const statePath = resolveConvergenceStatePath(paprDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function loadConvergenceStateForApp(
  appId: string,
  paprDir?: string,
): SourceConvergenceState | null {
  const state = loadConvergenceState(paprDir);
  const entries = Object.values(state.sources).filter(
    (entry) => entry.appId === appId,
  );
  if (entries.length === 0) {
    return null;
  }
  const driftTables = entries.flatMap((entry) => entry.driftTables);
  const ok = entries.every((entry) => entry.ok);
  const lastCheckedAt = entries
    .map((entry) => entry.lastCheckedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const lastVerifiedAt = entries
    .map((entry) => entry.lastVerifiedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  return {
    syncKey: appId,
    appId,
    alias: "all",
    lastCheckedAt,
    lastVerifiedAt,
    ok,
    driftTables,
  };
}

function resolveTursoDatabaseLabel(
  source: Awaited<ReturnType<typeof discoverTursoLinkedSources>>[number],
): string {
  const registry = getDatabaseRegistryService();
  if (source.dbId) {
    const record = registry.getById(source.dbId);
    if (record) {
      return record.tursoShortName;
    }
  }
  const byPath = registry.getByPath(source.dbPath);
  if (byPath) {
    return byPath.tursoShortName;
  }
  if (source.jobId) {
    return jobTursoDatabaseName(source.jobId);
  }
  return linkedSourceSyncKey(source);
}

export async function runConvergenceCheckForSource(
  source: Awaited<ReturnType<typeof discoverTursoLinkedSources>>[number],
): Promise<SourceConvergenceState> {
  const syncKey = linkedSourceSyncKey(source);
  const base: SourceConvergenceState = {
    syncKey,
    appId: source.appId,
    alias: source.alias,
    lastCheckedAt: new Date().toISOString(),
    lastVerifiedAt: null,
    ok: false,
    driftTables: [],
  };

  if (!fs.existsSync(source.dbPath)) {
    return { ...base, ok: true };
  }

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return { ...base, error: "Turso sync not initialized" };
  }

  let credentials;
  try {
    credentials = await bridge.fetchCredentials(resolveTursoDatabaseLabel(source));
  } catch (err) {
    return {
      ...base,
      error: `Turso credentials unavailable: ${(err as Error).message.slice(0, 120)}`,
    };
  }

  const remote = createClient({
    url: credentials.tursoUrl,
    authToken: credentials.authToken,
  });
  const localDb = openWritableLocalJobDb(source.dbPath);

  try {
    const tableNames = filterSyncableTables(listUserTables(localDb));
    const driftTables: string[] = [];

    for (const tableName of tableNames) {
      const localDigest = computeLocalTableConvergenceDigest(localDb, tableName);
      if (!localDigest) {
        continue;
      }
      const remoteDigest = await computeRemoteTableConvergenceDigest(remote, tableName);
      if (!remoteDigest || !digestsMatch(localDigest, remoteDigest)) {
        driftTables.push(tableName);
      }
    }

    const now = new Date().toISOString();
    return {
      ...base,
      ok: driftTables.length === 0,
      driftTables,
      lastVerifiedAt: driftTables.length === 0 ? now : null,
    };
  } catch (err) {
    return {
      ...base,
      error: (err as Error).message.slice(0, 160),
    };
  } finally {
    localDb.close();
    remote.close();
  }
}

export async function runConvergenceCheckForApp(
  appId: string,
  appsRootDir: string,
  paprDir?: string,
): Promise<SourceConvergenceState[]> {
  const sources = (await discoverTursoLinkedSources(appsRootDir)).filter(
    (source) => source.appId === appId,
  );
  const results: SourceConvergenceState[] = [];
  const state = loadConvergenceState(paprDir);

  for (const source of sources) {
    const result = await runConvergenceCheckForSource(source);
    results.push(result);
    state.sources[result.syncKey] = result;
  }

  saveConvergenceState(state, paprDir);
  return results;
}

export async function runConvergenceCheckForAllLinkedSources(
  paprDir?: string,
): Promise<void> {
  const root = paprDir ?? getPaprRoot();
  const appsRoot = path.join(root, "apps");
  const sources = await discoverTursoLinkedSources(appsRoot);
  const state = loadConvergenceState(root);
  const now = Date.now();

  for (const source of sources) {
    const syncKey = linkedSourceSyncKey(source);
    const existing = state.sources[syncKey];
    if (
      existing?.lastCheckedAt &&
      now - new Date(existing.lastCheckedAt).getTime() < CONVERGENCE_CHECK_INTERVAL_MS
    ) {
      continue;
    }
    const result = await runConvergenceCheckForSource(source);
    state.sources[syncKey] = result;
  }

  saveConvergenceState(state, root);
}
