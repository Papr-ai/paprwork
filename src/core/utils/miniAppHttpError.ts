/**
 * Mini-app HTTP error formatting (desktop preview overlay + injected fetch wrapper).
 */

export function parseApiErrorFromResponseBody(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = bodyText.trim().startsWith("{")
      ? (JSON.parse(trimmed) as { error?: unknown; message?: unknown })
      : null;
    if (parsed) {
      if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
        return parsed.error.trim();
      }
      if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
        return parsed.message.trim();
      }
    }
  } catch {
    /* plain text body */
  }
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
}

export function formatMiniAppHttpErrorMessage(
  status: number,
  bodyText: string,
  requestPath?: string,
): string {
  const detail = parseApiErrorFromResponseBody(bodyText) ?? `HTTP ${status}`;
  const path = requestPath ?? "";
  if (path.includes("/api/jobs/run") && status === 404) {
    if (/job not found/i.test(detail)) {
      return detail;
    }
    return `Job not found (${status}): ${detail}`;
  }
  return `Request failed (${status}): ${detail}`;
}

/** True when the migration / data-sources.json hint is plausibly relevant. */
export function shouldShowDataSourcesMigrationHint(errorMessage: string): boolean {
  const m = errorMessage.trim().toLowerCase();
  if (m.length === 0) {
    return false;
  }

  const unrelated =
    m.includes("job not found") ||
    m.includes("no such table") ||
    m.includes("sqlite_unknown") ||
    m.includes("short read on wal") ||
    m.includes("wal frame") ||
    m.includes("sync engine operation failed") ||
    m.includes("i/o error") ||
    m.includes("replica") ||
    m.includes("turso") ||
    m.includes("schema update pending") ||
    m.includes("database sync in progress");

  if (unrelated) {
    return false;
  }

  return (
    m.includes("no data sources linked") ||
    m.includes("no linked database") ||
    m.includes("local database not found") ||
    m.includes("data-sources.json") ||
    m.includes("linked database path") ||
    (m.includes("not found") &&
      (m.includes("database") || m.includes("dbpath") || m.includes("data source")))
  );
}

export function normalizeMiniAppRuntimeErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  const prefix = "Unhandled rejection:";
  const inner = trimmed.startsWith(prefix)
    ? trimmed.slice(prefix.length).trim()
    : trimmed;
  if (inner.length > 0) {
    return inner;
  }
  return "Request failed (no error details were provided by the app).";
}
