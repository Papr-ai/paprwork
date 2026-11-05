/**
 * Turn electron-updater errors into something a person can read.
 *
 * Raw errors can be a whole HTTP dump, e.g. when GitHub is overloaded:
 *   529 "method: GET url: https://github.com/Papr-ai/paprwork/releases.atom\n\n Data: …" Headers: { … }
 * `transient` marks failures that fix themselves (server busy, network): the
 * banner stays quiet for those and the check is retried later.
 */

const UPDATE_RECOVERY_HINT =
  "If the app won't open after updating: quit Papr Work, delete " +
  "~/Library/Caches/com.paprwork.v2.ShipIt, remove /Applications/Papr Work.app, " +
  "then reinstall the latest arm64 .pkg from GitHub Releases.";

const RETRY_HINT = "Papr Work will try again on its own. You can also check now from Settings → About.";

/** Leading HTTP status in electron-updater's HttpError message, or null. */
function httpStatusOf(message) {
  const m = /^\s*(?:HttpError:\s*)?(\d{3})\b/.exec(message);
  return m ? Number(m[1]) : null;
}

/** First line, without the request dump, capped at a word boundary. */
function firstLine(message, max = 200) {
  const line = message.split(/\\n|\n/)[0].replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * @param {unknown} rawMessage
 * @returns {{ error: string, recoveryHint?: string, transient?: boolean }}
 */
function formatUpdateError(rawMessage) {
  const message =
    typeof rawMessage === "string" ? rawMessage : String(rawMessage ?? "Unknown error");
  const lower = message.toLowerCase();

  if (lower.includes("read-only volume") || lower.includes("readonly")) {
    return {
      error:
        "Update cannot install while Papr Work is on a read-only volume. " +
        "Install to /Applications using the .pkg installer.",
      recoveryHint: UPDATE_RECOVERY_HINT,
    };
  }

  const status = httpStatusOf(message);
  if (status !== null && (status >= 500 || status === 429 || status === 408)) {
    return {
      error: `GitHub is busy right now, so the update check didn't go through (error ${status}).`,
      recoveryHint: RETRY_HINT,
      transient: true,
    };
  }
  if (status === 404 || status === 403 || status === 401) {
    return {
      error: `Couldn't read the update list from GitHub (error ${status}).`,
      recoveryHint: RETRY_HINT,
      transient: true,
    };
  }

  if (
    lower.includes("shipit") ||
    lower.includes("signature") ||
    lower.includes("codesign") ||
    lower.includes("seckey") ||
    lower.includes("corrupt") ||
    lower.includes("damaged")
  ) {
    return {
      error: `Update installation failed: ${firstLine(message)}`,
      recoveryHint: UPDATE_RECOVERY_HINT,
    };
  }

  if (
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("net::") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("timed out")
  ) {
    return {
      error: "Could not reach the update server.",
      recoveryHint: "Check your internet connection. " + RETRY_HINT,
      transient: true,
    };
  }

  if (lower.includes("not packaged")) {
    return {
      error: message,
      recoveryHint: "Auto-updates only work in packaged builds from GitHub Releases.",
    };
  }

  return { error: firstLine(message) };
}

module.exports = { formatUpdateError, UPDATE_RECOVERY_HINT, httpStatusOf };
