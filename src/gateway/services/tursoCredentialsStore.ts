/**
 * Persist Turso sync credentials per database for offline replica open.
 * File: ~/Papr/data/.turso-credentials.json (workspace-scoped, mode 0o600).
 *
 * Entries are keyed by WHO ASKED: `{org}/{namespace}/{user}/{shortName}`
 * (see `tursoCredentialsScopeKey`). Short names like `sync-index` are reused
 * in every workspace and resolve to a different Turso database per org /
 * namespace / user, so a short-name key alone could hand one workspace's
 * token to another. Keying by the full requester identity makes that
 * impossible without wiping the store on every launch or workspace switch.
 *
 * The stored `tursoUrl` is whatever the memory server returned. For team
 * shared databases that URL points at the PUBLISHER's segment (the server
 * resolves it via publish ACL) — never validate it against the caller.
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
  /**
   * Namespace of the Papr API key that fetched this token. The key decides
   * which segment the server resolves `tursoUrl` to, so a token fetched with
   * another workspace's key points at THAT workspace's databases even though
   * it is filed under this one (Oct 20: p-y8d4h7yp-85zib7md-* filed under
   * 6hqIK7Erba/XHqOmymyGP). Absent on entries written before this field.
   */
  keyNamespaceId?: string;
}

export interface TursoCredentialsStoreFile {
  databases: Record<string, TursoCredentialsRecord>;
}

/** Identity of the requester a token was issued to. */
export interface TursoCredentialsScope {
  organizationId: string;
  namespaceId: string;
  userId: string;
}

/**
 * Cache key for one database as seen by one requester. Returns null when any
 * identity part is unknown — callers must then skip the cache (fail closed).
 */
export function tursoCredentialsScopeKey(
  scope: TursoCredentialsScope | null | undefined,
  databaseName: string,
): string | null {
  const org = scope?.organizationId?.trim();
  const ns = scope?.namespaceId?.trim();
  const user = scope?.userId?.trim();
  const db = databaseName.trim();
  if (!org || !ns || !user || !db) {
    return null;
  }
  return `${org}/${ns}/${user}/${db}`;
}

/** Legacy (pre-scope) entries are keyed by bare short name — never trusted. */
function isScopedKey(key: string): boolean {
  return key.split("/").length === 4;
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

/** Namespace segment of a scoped key (`org/ns/user/db`). */
function scopedKeyNamespace(key: string): string | null {
  const parts = key.split("/");
  return parts.length === 4 ? parts[1] : null;
}

/**
 * True when the record was fetched with a key for a different namespace than
 * the one it is filed under — its URL belongs to another workspace.
 */
export function isTursoCredentialsRecordMisbound(
  key: string,
  record: Pick<TursoCredentialsRecord, "keyNamespaceId">,
): boolean {
  const filedUnder = scopedKeyNamespace(key);
  const fetchedWith = record.keyNamespaceId?.trim();
  return Boolean(filedUnder && fetchedWith && fetchedWith !== filedUnder);
}

/**
 * Look up by scoped key (`tursoCredentialsScopeKey`). Legacy keys never match.
 * Misbound entries (fetched with another workspace's key) are dropped.
 */
export function getTursoCredentialsEntry(
  key: string,
  paprDir?: string,
): TursoCredentialsRecord | null {
  if (!isScopedKey(key)) {
    return null;
  }
  const store = loadTursoCredentialsStore(paprDir);
  const record = store.databases[key] ?? null;
  if (record && isTursoCredentialsRecordMisbound(key, record)) {
    console.warn(
      `[TursoCredentials] Dropping ${key} — fetched with a key for namespace ${record.keyNamespaceId}`,
    );
    delete store.databases[key];
    saveTursoCredentialsStore(store, paprDir);
    return null;
  }
  return record;
}

export function saveTursoCredentialsEntry(
  key: string,
  creds: TursoCredentials,
  expiresAtMs: number,
  paprDir?: string,
  keyNamespaceId?: string | null,
): void {
  if (!isScopedKey(key)) {
    return;
  }
  if (keyNamespaceId && isTursoCredentialsRecordMisbound(key, { keyNamespaceId })) {
    console.warn(
      `[TursoCredentials] Refusing to persist ${key} — fetched with a key for namespace ${keyNamespaceId}`,
    );
    return;
  }
  const store = loadTursoCredentialsStore(paprDir);
  // Prune legacy unscoped entries and long-expired tokens as we go.
  const now = Date.now();
  for (const [existingKey, record] of Object.entries(store.databases)) {
    if (!isScopedKey(existingKey) || record.expiresAtMs < now - 7 * 86_400_000) {
      delete store.databases[existingKey];
    }
  }
  store.databases[key] = {
    tursoUrl: creds.tursoUrl,
    authToken: creds.authToken,
    expiresAtMs,
    updatedAt: new Date().toISOString(),
    ...(keyNamespaceId ? { keyNamespaceId } : {}),
  };
  saveTursoCredentialsStore(store, paprDir);
}

export function removeTursoCredentialsEntry(
  key: string,
  paprDir?: string,
): void {
  const store = loadTursoCredentialsStore(paprDir);
  if (!(key in store.databases)) {
    return;
  }
  delete store.databases[key];
  saveTursoCredentialsStore(store, paprDir);
}

/** Tests / explicit sign-out only — never called on launch or workspace switch. */
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
