/**
 * Tracks user-facing gateway work (chat streams, mini-app static hosting,
 * mini-app DB reads) so deferred background init can yield until the hot path is quiet.
 */

let interactiveDepth = 0;

export function enterInteractiveHotPath(_label?: string): void {
  interactiveDepth += 1;
}

export function leaveInteractiveHotPath(_label?: string): void {
  interactiveDepth = Math.max(0, interactiveDepth - 1);
}

export async function withInteractiveHotPath<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  enterInteractiveHotPath(label);
  try {
    return await fn();
  } finally {
    leaveInteractiveHotPath(label);
  }
}

export function getInteractiveHotPathDepth(): number {
  return interactiveDepth;
}

export async function countRunningAgentStreams(): Promise<number> {
  const { getAgentStreamRegistry } = await import("./AgentStreamRegistry.js");
  return getAgentStreamRegistry().countRunningStreams();
}

export async function isInteractiveHotPathBusy(): Promise<boolean> {
  if (interactiveDepth > 0) {
    return true;
  }
  return (await countRunningAgentStreams()) > 0;
}

export interface WaitForInteractiveQuietOptions {
  /** Sustained idle time required before background work proceeds. */
  minQuietMs?: number;
  /** Upper bound — background work runs anyway after this wait. */
  maxWaitMs?: number;
  pollMs?: number;
}

/**
 * Wait until no interactive hot-path work is active for minQuietMs,
 * or until maxWaitMs elapses (then proceed so background jobs cannot stall forever).
 */
export async function waitForInteractiveQuietBeforeBackgroundWork(
  label: string,
  options: WaitForInteractiveQuietOptions = {},
): Promise<void> {
  const minQuietMs = options.minQuietMs ?? readEnvMs("GATEWAY_INTERACTIVE_QUIET_MS", 2000);
  const maxWaitMs =
    options.maxWaitMs ?? readEnvMs("GATEWAY_INTERACTIVE_MAX_WAIT_MS", 120_000);
  const pollMs = options.pollMs ?? 250;

  const startedAt = Date.now();
  let quietSinceMs: number | null = null;

  while (Date.now() - startedAt < maxWaitMs) {
    const busy = await isInteractiveHotPathBusy();
    if (!busy) {
      quietSinceMs ??= Date.now();
      if (Date.now() - quietSinceMs >= minQuietMs) {
        console.log(
          `[GatewayInteractive] ${label}: hot path quiet ≥${minQuietMs}ms — starting`,
        );
        return;
      }
    } else {
      quietSinceMs = null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  console.log(
    `[GatewayInteractive] ${label}: waited ${maxWaitMs}ms — starting anyway`,
  );
}

function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
