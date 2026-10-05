/**
 * File lock that holds across processes (gateway + publish worker).
 *
 * withFileEditLock only serializes callers inside one process. Sync bookkeeping
 * files (outbox, OID cache, commit cursors, repo registry cache) are now
 * read-modify-written by the gateway AND the publish worker, so each rewrite
 * also takes `<file>.lock`, created with O_EXCL.
 *
 * A lock whose owner pid is dead, or that is older than STALE_MS, is broken —
 * a crashed worker never wedges the gateway. Lock bodies are short file
 * rewrites, so a live holder past STALE_MS is not a real case.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { withFileEditLock } from "./fileEditLock.js";

const STALE_MS = 60_000;
const EMPTY_GRACE_MS = 2_000;
const POLL_MS = 10;
const MAX_WAIT_MS = 30_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the existing lock can be broken. */
async function lockIsStale(lockPath: string): Promise<boolean> {
  let raw: string;
  let mtimeMs: number;
  try {
    [raw, { mtimeMs }] = await Promise.all([
      fs.readFile(lockPath, "utf8"),
      fs.stat(lockPath),
    ]);
  } catch {
    return false; // vanished between EEXIST and read — just retry
  }
  const [pidText, atText] = raw.trim().split(" ");
  const pid = Number(pidText);
  const at = Number(atText);
  if (!pid || !at) {
    // Created but not yet written by its owner: only stale if it stays empty.
    return Date.now() - mtimeMs > EMPTY_GRACE_MS;
  }
  return !pidAlive(pid) || Date.now() - at > STALE_MS;
}

async function acquire(lockPath: string): Promise<void> {
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}`, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    if (await lockIsStale(lockPath)) {
      await fs.unlink(lockPath).catch(() => undefined);
      continue;
    }
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      throw new Error(`Timed out waiting for ${path.basename(lockPath)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Serialize `fn` against every process rewriting `filePath`. */
export function withCrossProcessFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  return withFileEditLock(`xproc:${filePath}`, async () => {
    await acquire(lockPath);
    try {
      return await fn();
    } finally {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  });
}
