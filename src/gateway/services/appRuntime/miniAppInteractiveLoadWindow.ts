/**
 * After a mini-app tab opens, prefer local replica reads and defer replica push
 * so first paint is not blocked by sync or racing Turso primary.
 */

const loadWindowUntilByAppId = new Map<string, number>();

function readLoadWindowMs(): number {
  const raw = process.env.MINI_APP_LOAD_WINDOW_MS?.trim();
  if (!raw) {
    return 20_000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20_000;
}

/** Extend (or start) the interactive load window for this app. */
export function markMiniAppInteractiveLoadWindow(appId: string): void {
  const ms = readLoadWindowMs();
  if (ms === 0) {
    loadWindowUntilByAppId.delete(appId);
    return;
  }
  const until = Date.now() + ms;
  const prev = loadWindowUntilByAppId.get(appId) ?? 0;
  loadWindowUntilByAppId.set(appId, Math.max(prev, until));
}

export function isMiniAppInInteractiveLoadWindow(appId: string): boolean {
  const until = loadWindowUntilByAppId.get(appId);
  if (until === undefined) {
    return false;
  }
  if (Date.now() >= until) {
    loadWindowUntilByAppId.delete(appId);
    return false;
  }
  return true;
}

/** During load window, do not race or fall back to Turso primary for mini-app reads. */
export function shouldMiniAppUseReplicaOnlyForReads(appId: string): boolean {
  if (process.env.MINI_APP_LOAD_REPLICA_ONLY === "false") {
    return false;
  }
  return isMiniAppInInteractiveLoadWindow(appId);
}

/** @internal */
export function resetMiniAppInteractiveLoadWindowForTests(): void {
  loadWindowUntilByAppId.clear();
}
