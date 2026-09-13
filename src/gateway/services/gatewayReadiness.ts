/**
 * Tracks when the gateway HTTP server has finished registering all routes
 * (gatewayReady in index.ts). Distinct from workspace readiness — vault sync
 * and other localhost→gateway loops should wait for this before hitting /api/cloud/*.
 */

let routesReady = false;
const waiters: Array<() => void> = [];

export function markGatewayRoutesReady(): void {
  if (routesReady) {
    return;
  }
  routesReady = true;
  for (const resolve of waiters) {
    resolve();
  }
  waiters.length = 0;
}

export function isGatewayRoutesReady(): boolean {
  return routesReady;
}

/** Resolves true when routes are ready, false on timeout. */
export async function waitForGatewayRoutesReady(
  timeoutMs = 120_000,
): Promise<boolean> {
  if (routesReady) {
    return true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    waiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
