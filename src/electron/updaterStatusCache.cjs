/**
 * Last auto-update status for replay when the renderer mounts after IPC events.
 */

/** @typedef {{ status: string, version?: string, releaseNotes?: string, percent?: number, error?: string, recoveryHint?: string }} UpdateStatusPayload */

/**
 * Whether `next` should replace `current` in the durable cache.
 * @param {UpdateStatusPayload | null} current
 * @param {UpdateStatusPayload} next
 * @returns {boolean}
 */
function shouldReplaceCachedUpdateStatus(current, next) {
  if (!current) {
    return true;
  }
  if (next.status === "not-available" || next.status === "checking") {
    if (
      current.status === "ready" ||
      current.status === "downloading" ||
      current.status === "available" ||
      current.status === "error"
    ) {
      return false;
    }
  }
  if (next.status === "checking" && current.status === "downloading") {
    return false;
  }
  return true;
}

/**
 * @param {UpdateStatusPayload | null} current
 * @param {UpdateStatusPayload} next
 * @returns {UpdateStatusPayload}
 */
function mergeUpdateStatusCache(current, next) {
  if (shouldReplaceCachedUpdateStatus(current, next)) {
    return { ...next };
  }
  return current;
}

module.exports = {
  shouldReplaceCachedUpdateStatus,
  mergeUpdateStatusCache,
};
