/**
 * Release @tursodatabase/sync handles before desktop jobs use stdlib sqlite3.
 *
 * Plan A registry DBs must not have the sync engine and sqlite3/better-sqlite3
 * open the same file concurrently — that corrupts sync sidecars (WAL wedge).
 * Backend handlers use the gateway proxy; jobs still receive local file paths
 * and commonly call sqlite3.connect(APP_DB).
 */

import { getTursoReplicaService } from "./TursoReplicaService.js";
import { isReplicaManagedDbPath } from "./tursoReplicaFileGuard.js";

/** Close the embedded replica handle so job sqlite3 can safely open the file. */
export async function releaseReplicaHandleForJob(dbPath: string): Promise<boolean> {
  if (!isReplicaManagedDbPath(dbPath)) {
    return false;
  }
  const replica = getTursoReplicaService();
  await replica.close(dbPath);
  return true;
}
