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

/** Parse /health JSON body. Gateway returns { status: "ok" | "starting" | "switching", syncBusy?: boolean }. */
function parseHealthResponse(body) {
  try {
    const parsed = JSON.parse(body);
    const syncBusy = parsed.syncBusy === true;
    // syncBusy is a grace hint for periodic health (don't SIGKILL during upload).
    // Once status is "ok", the gateway is ready — do not block startup on syncBusy.
    if (parsed.status === "ok") {
      return syncBusy
        ? { alive: true, ready: true, syncBusy: true }
        : { alive: true, ready: true };
    }
    if (syncBusy) {
      return { alive: true, ready: false, syncBusy: true };
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
  if (health.syncBusy) {
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

/** Read gateway sync busy marker written during Upload now / long flush. */
function parseGatewaySyncBusyState(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      typeof parsed?.appId !== "string" ||
      typeof parsed?.startedAtMs !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isGatewaySyncBusyGraceActive(
  state,
  nowMs = Date.now(),
  maxAgeMs = 15 * 60_000,
) {
  if (!state) {
    return false;
  }
  const age = nowMs - state.startedAtMs;
  return age >= 0 && age < maxAgeMs;
}

/**
 * Pick which PIDs reported on the gateway port are safe to SIGKILL.
 *
 * `lsof -ti:PORT` reports every socket on the port, including *outbound client*
 * connections. The Electron main process POSTs to the gateway while starting up,
 * so when an orphaned gateway is answering on the port that POST connects and
 * main's own PID joins the list. The supervisor then SIGKILLs itself ~0.6s into
 * launch and the app never loads. Without an orphan the POST is refused, no
 * socket exists, and the bug stays invisible — so filter here as well as passing
 * `-sTCP:LISTEN`, and never return a PID we depend on.
 */
function selectOrphanPidsToKill(rawOutput, protectedPids = []) {
  if (typeof rawOutput !== "string") {
    return [];
  }
  const protectedSet = new Set(
    protectedPids
      .map((pid) => Number.parseInt(String(pid), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );

  const seen = new Set();
  const result = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    // Drop blank lines, non-numeric noise, and pid 0 (kernel / whole process group).
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (protectedSet.has(pid) || seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
  }
  return result;
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
  parseGatewaySyncBusyState,
  isGatewaySyncBusyGraceActive,
  selectOrphanPidsToKill,
  isValidTransition,
  VALID_STATE_TRANSITIONS,
};
