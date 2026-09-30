import { isSpawnResourceError } from "./childProcessErrors.js";

type SpawnResourceErrorHandler = (reason: string) => void;

let handler: SpawnResourceErrorHandler | null = null;

/** Gateway registers FD recovery at startup (core must not import gateway). */
export function setSpawnResourceErrorHandler(
  next: SpawnResourceErrorHandler | null,
): void {
  handler = next;
}

export function notifySpawnResourceError(
  error: unknown,
  reason: string,
): void {
  if (!isSpawnResourceError(error)) {
    return;
  }
  try {
    handler?.(reason);
  } catch (err) {
    console.warn(
      "[SpawnResourceError] handler failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
