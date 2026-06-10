/**
 * Serializes read-modify-write edits per file key so parallel tool calls
 * cannot clobber each other's changes.
 */

const editChains = new Map<string, Promise<unknown>>();

export async function withFileEditLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = editChains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  editChains.set(key, run);
  try {
    return await run;
  } finally {
    if (editChains.get(key) === run) {
      editChains.delete(key);
    }
  }
}
