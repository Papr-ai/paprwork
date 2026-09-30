/**
 * Back off vault HTTP when memory.papr.ai returns server errors (500+).
 * Avoids stacking 90s+ resume-cloud / workspace-switch retries while the platform is unhealthy.
 */

let consecutiveServerErrors = 0;
let pausedUntilMs = 0;
let lastFailureSummary: string | null = null;

const MIN_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

function computeCooldownMs(): number {
  const exponent = Math.max(0, consecutiveServerErrors - 1);
  return Math.min(MAX_COOLDOWN_MS, MIN_COOLDOWN_MS * 2 ** exponent);
}

export function recordVaultSyncPlatformFailure(
  status: number,
  detail?: string,
): void {
  if (status < 500) {
    return;
  }
  consecutiveServerErrors += 1;
  const cooldownMs = computeCooldownMs();
  pausedUntilMs = Date.now() + cooldownMs;
  lastFailureSummary = detail?.slice(0, 240) ?? `HTTP ${status}`;
  console.warn(
    `[VaultSync] Platform error ${status} — pausing vault HTTP for ${Math.round(cooldownMs / 1000)}s` +
      (lastFailureSummary ? ` (${lastFailureSummary})` : ""),
  );
}

export function recordVaultSyncPlatformSuccess(): void {
  consecutiveServerErrors = 0;
  pausedUntilMs = 0;
  lastFailureSummary = null;
}

export function isVaultSyncPlatformPaused(): boolean {
  return Date.now() < pausedUntilMs;
}

export function getVaultSyncPlatformPauseReason(): string | null {
  if (!isVaultSyncPlatformPaused()) {
    return null;
  }
  const remainingSec = Math.ceil((pausedUntilMs - Date.now()) / 1000);
  return (
    lastFailureSummary ??
    `Vault sync paused after platform errors (retry in ~${remainingSec}s)`
  );
}

/** @internal test hook */
export function resetVaultSyncPlatformBackoffForTests(): void {
  consecutiveServerErrors = 0;
  pausedUntilMs = 0;
  lastFailureSummary = null;
}
