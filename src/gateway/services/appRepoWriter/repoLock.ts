/**
 * Per-app mutex for writer git operations (in-process; composed with Mongo lease).
 */

const locks = new Map<string, Promise<void>>();
const tail = new Map<string, Promise<void>>();

export async function withAppRepoLock<T>(
  appId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = tail.get(appId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const chained = previous.then(() => gate);
  tail.set(appId, chained);
  locks.set(appId, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tail.get(appId) === chained) {
      tail.delete(appId);
      locks.delete(appId);
    }
  }
}

/** Test-only — reset lock state. */
export function resetAppRepoLocksForTests(): void {
  locks.clear();
  tail.clear();
}
