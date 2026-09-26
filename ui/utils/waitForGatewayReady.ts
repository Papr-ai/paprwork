/**
 * Resolve once the local gateway has finished loading its services.
 *
 * The WebSocket accepts connections before routes and the agent runtime are
 * registered, so "connected" is not "ready". The supervisor's latched status
 * is the real signal. Sending the first onboarding prompt before this made the
 * chat sit silent for several seconds ("Gateway still starting…"), which reads
 * as broken — so onboarding holds on its own screen instead.
 *
 * Never blocks forever: resolves `false` after `timeoutMs` so a slow boot
 * degrades to the old behaviour rather than a dead button. Resolves `true`
 * immediately outside Electron (no supervisor to ask).
 */

interface GatewayStatusApi {
  getStatus?: () => Promise<{ status: string } | null>;
}

function statusApi(): GatewayStatusApi | undefined {
  return (window as unknown as { electronAPI?: { gateway?: GatewayStatusApi } })
    .electronAPI?.gateway;
}

const isReady = (status: string | undefined) =>
  status === "ready" || status === "running";

/** One-shot check — for deciding whether to show a "getting ready" state at all. */
export async function isGatewayReady(): Promise<boolean> {
  const api = statusApi();
  if (!api?.getStatus) return true;
  const current = await api.getStatus().catch(() => null);
  // null = supervisor never pushed anything (dev gateway run separately).
  return !current || isReady(current.status);
}

export async function waitForGatewayReady(
  timeoutMs = 30_000,
  intervalMs = 300,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayReady()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
