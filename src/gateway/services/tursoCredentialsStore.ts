/**
 * Persist Turso sync credentials per database for offline replica open.
 * File: ~/Papr/data/.turso-credentials.json (workspace-scoped, mode 0o600).
 */

import * as fs from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import type { TursoCredentials } from "./tursoSyncBridgeCore.js";

export const TURSO_CREDENTIALS_FILENAME = ".turso-credentials.json";

export interface TursoCredentialsRecord {
  tursoUrl: string;
  authToken: string;
  /** Unix ms — server token expiry minus safety margin. */
  expiresAtMs: number;
  updatedAt: string;
}

export interface TursoCredentialsStoreFile {
  databases: Record<string, TursoCredentialsRecord>;
}

function defaultStore(): TursoCredentialsStoreFile {
  return { databases: {} };
}

export function resolveTursoCredentialsStorePath(paprDir?: string): string {
  const root = paprDir ?? getPaprRoot();
  return path.join(root, "data", TURSO_CREDENTIALS_FILENAME);
}

export function loadTursoCredentialsStore(
  paprDir?: string,
): TursoCredentialsStoreFile {
  const storePath = resolveTursoCredentialsStorePath(paprDir);
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as TursoCredentialsStoreFile;
    if (parsed && typeof parsed === "object" && parsed.databases) {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return defaultStore();
}

export function saveTursoCredentialsStore(
  store: TursoCredentialsStoreFile,
  paprDir?: string,
): void {
  const storePath = resolveTursoCredentialsStorePath(paprDir);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function getTursoCredentialsEntry(
  databaseName: string,
  paprDir?: string,
): TursoCredentialsRecord | null {
  const store = loadTursoCredentialsStore(paprDir);
  return store.databases[databaseName] ?? null;
}

export function saveTursoCredentialsEntry(
  databaseName: string,
  creds: TursoCredentials,
  expiresAtMs: number,
  paprDir?: string,
): void {
  const store = loadTursoCredentialsStore(paprDir);
  store.databases[databaseName] = {
    tursoUrl: creds.tursoUrl,
    authToken: creds.authToken,
    expiresAtMs,
    updatedAt: new Date().toISOString(),
  };
  saveTursoCredentialsStore(store, paprDir);
}

export function removeTursoCredentialsEntry(
  databaseName: string,
  paprDir?: string,
): void {
  const store = loadTursoCredentialsStore(paprDir);
  if (!(databaseName in store.databases)) {
    return;
  }
  delete store.databases[databaseName];
  saveTursoCredentialsStore(store, paprDir);
}

export function clearTursoCredentialsStore(paprDir?: string): void {
  saveTursoCredentialsStore(defaultStore(), paprDir);
}

export function tursoCredentialsFromRecord(
  record: TursoCredentialsRecord,
): TursoCredentials {
  return {
    tursoUrl: record.tursoUrl,
    authToken: record.authToken,
  };
}
