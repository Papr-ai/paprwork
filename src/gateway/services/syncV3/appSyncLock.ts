/**
 * One sync operation per app at a time.
 *
 * Publish (flushAppNow → finalize: held-database publish, code upload, switch-over)
 * and Get updates (pullAppCodeFromRepo: merge remote files, apply migrations)
 * both rewrite the same app folder and linked databases. Run together, a pull
 * can land files between "database migrated" and "code uploaded", or a publish
 * can upload half-merged files. They now queue behind each other per app.
 *
 * The publish worker is driven from inside flushAppNow and awaited there, so
 * holding the lock in the gateway covers the worker's push as well.
 *
 * Re-entrant: a call made while already holding the app's lock (same async
 * chain) runs immediately instead of deadlocking.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const tails = new Map<string, Promise<void>>();
const holding = new AsyncLocalStorage<ReadonlySet<string>>();
const current = new Map<string, string>();

/** What currently holds the app's lock (for logs / status), if anything. */
export function appSyncLockHolder(appId: string): string | undefined {
  return current.get(appId);
}

export async function withAppSyncLock<T>(
  appId: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const held = holding.getStore();
  if (held?.has(appId)) {
    return fn();
  }

  const previous = tails.get(appId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(appId, tail);

  const waitingOn = current.get(appId);
  if (waitingOn) {
    console.log(`[AppSyncLock] ${appId}: ${label} waiting for ${waitingOn}`);
  }
  await previous;
  current.set(appId, label);

  const next = new Set(held ?? []);
  next.add(appId);
  try {
    return await holding.run(next, fn);
  } finally {
    current.delete(appId);
    release();
    if (tails.get(appId) === tail) {
      tails.delete(appId);
    }
  }
}
