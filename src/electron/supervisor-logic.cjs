/**
 * Gateway Process Supervisor — Pure Logic Functions
 *
 * Extracted for unit testing without Electron dependencies.
 * Used by GatewayProcessSupervisor in index.cjs.
 */

function calculateBackoff(restartCount, baseMs = 500, maxMs = 30000) {
  return Math.min(baseMs * Math.pow(2, restartCount), maxMs);
}

function isCircuitBroken(timestamps, now, windowMs = 300000, maxRestarts = 5) {
  const recent = timestamps.filter((t) => now - t < windowMs);
  return recent.length >= maxRestarts;
}

function pruneTimestamps(timestamps, now, windowMs = 300000) {
  return timestamps.filter((t) => now - t < windowMs);
}

function getNotificationType(restartCount, silentThreshold = 2, bannerThreshold = 4) {
  if (restartCount <= silentThreshold) return "silent";
  if (restartCount <= bannerThreshold) return "banner";
  return "dialog";
}

function shouldKillProcess(consecutiveFailures, isSuccess, threshold = 3) {
  if (isSuccess) return { newCount: 0, shouldKill: false };
  const newCount = consecutiveFailures + 1;
  return { newCount, shouldKill: newCount >= threshold };
}

/** Parse /health JSON body. Gateway returns { status: "ok" | "starting" | "switching" }. */
function parseHealthResponse(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed.status === "ok") {
      return { alive: true, ready: true };
    }
    if (parsed.status === "starting" || parsed.status === "switching") {
      return { alive: true, ready: false };
    }
    return { alive: false, ready: false };
  } catch {
    return { alive: false, ready: false };
  }
}

/**
 * During cold start the gateway may respond with status "starting" for 60s+
 * while loading a large chats.db. Never SIGKILL until we've seen status "ok".
 */
function shouldKillUnhealthyGateway(
  consecutiveFailures,
  health,
  hasEverBeenHealthy,
  threshold = 5,
) {
  if (health.ready) {
    return { newCount: 0, shouldKill: false };
  }
  if (health.alive && !health.ready) {
    return { newCount: 0, shouldKill: false };
  }
  if (!hasEverBeenHealthy) {
    return { newCount: consecutiveFailures, shouldKill: false };
  }
  const newCount = consecutiveFailures + 1;
  return { newCount, shouldKill: newCount >= threshold };
}

const VALID_STATE_TRANSITIONS = {
  stopped: ["starting"],
  starting: ["running", "backoff", "stopped"],
  running: ["backoff", "stopped"],
  backoff: ["starting", "failed", "stopped"],
  failed: ["starting", "stopped"],
};

function isValidTransition(from, to) {
  return (VALID_STATE_TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  calculateBackoff,
  isCircuitBroken,
  pruneTimestamps,
  getNotificationType,
  shouldKillProcess,
  parseHealthResponse,
  shouldKillUnhealthyGateway,
  isValidTransition,
  VALID_STATE_TRANSITIONS,
};
