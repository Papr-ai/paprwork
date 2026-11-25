/**
 * Forked sync identity recovery.
 *
 * The sync engine names each replica with a client id stored in `{db}-info`. The
 * cloud keeps one progress counter (pull_gen) per client id. Two copies of the same
 * files (folder copy, backup restore, iCloud/Dropbox sync) share that id: once one
 * copy syncs, the other is behind its own id's counter and every pull/push fails
 * with `remote_pull_gen > local_pull_gen` / `target_pull_gen > source_pull_gen`.
 *
 * Nothing else produces that error, and the engine never recovers by itself. The
 * fix is to give this replica a fresh id and keep everything else: data, the
 * engine's own list of unsent changes and its synced revision. Verified against the
 * real engine (0.8.4): pending insert/update/delete all reach the cloud and cloud
 * deletes arrive. There is still exactly one cloud database — only this desktop's
 * name changes, like signing a device in again.
 *
 * Version guard: `{db}-info` belongs to the sync library. We only rewrite the one
 * field when the file is the format we tested (`version: "v1"` with a string
 * `client_unique_id`). Anything else is left untouched and the original error
 * surfaces, so a future library format can never be corrupted by us.
 */

import * as crypto from "crypto";
import * as fs from "fs";

const FORKED_CLIENT_PATTERNS = [
  "remote_pull_gen > local_pull_gen",
  "target_pull_gen > source_pull_gen",
] as const;

export function isReplicaForkedClientError(message: string): boolean {
  return FORKED_CLIENT_PATTERNS.some((pattern) => message.includes(pattern));
}

export type ReplicaRekeyResult =
  | { ok: true; previousId: string; clientId: string }
  | { ok: false; reason: "info_missing" | "info_unreadable" | "unsupported_format" };

const CLIENT_ID_PREFIX = "paprwork-desktop-";

/**
 * Give the replica at `dbPath` a new sync client id. The caller must have closed
 * the engine handle for this path first (the engine rewrites `-info` while open).
 */
export function rekeyReplicaClientId(dbPath: string): ReplicaRekeyResult {
  const infoPath = `${dbPath}-info`;
  if (!fs.existsSync(infoPath)) {
    return { ok: false, reason: "info_missing" };
  }
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "info_unreadable" };
  }
  const previousId = info.client_unique_id;
  if (info.version !== "v1" || typeof previousId !== "string" || !previousId) {
    return { ok: false, reason: "unsupported_format" };
  }
  const clientId = `${CLIENT_ID_PREFIX}${crypto.randomUUID()}`;
  const next = { ...info, client_unique_id: clientId };
  const tmpPath = `${infoPath}.rekey-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(next));
  fs.renameSync(tmpPath, infoPath);
  return { ok: true, previousId, clientId };
}
