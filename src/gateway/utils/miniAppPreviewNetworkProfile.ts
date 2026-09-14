/**
 * Summarize mini-app preview network activity for validate_app load warnings.
 */

export interface WebviewNetworkLogEntry {
  url: string;
  method?: string;
  statusCode?: number;
  status?: number;
  resourceType?: string;
  timestamp?: string;
}

export interface PreviewNetworkProfile {
  dbQueryCount: number;
  dbBatchCount: number;
  dbWriteCount: number;
  jobsEventsCount: number;
  warnings: string[];
}

const DB_QUERY_WARN_THRESHOLD = 4;

function isApiDbUrl(url: string, suffix: string): boolean {
  try {
    const path = url.includes("://") ? new URL(url).pathname : url;
    return path === `/api/db/${suffix}` || path.endsWith(`/api/db/${suffix}`);
  } catch {
    return url.includes(`/api/db/${suffix}`);
  }
}

export function analyzePreviewNetworkLogs(
  logs: WebviewNetworkLogEntry[],
): PreviewNetworkProfile {
  let dbQueryCount = 0;
  let dbBatchCount = 0;
  let dbWriteCount = 0;
  let jobsEventsCount = 0;

  for (const entry of logs) {
    const url = entry.url ?? "";
    if (isApiDbUrl(url, "query")) {
      dbQueryCount++;
    } else if (isApiDbUrl(url, "batch")) {
      dbBatchCount++;
    } else if (isApiDbUrl(url, "write") || isApiDbUrl(url, "exec")) {
      dbWriteCount++;
    } else if (url.includes("/api/jobs/events")) {
      jobsEventsCount++;
    }
  }

  const warnings: string[] = [];

  if (
    dbQueryCount >= DB_QUERY_WARN_THRESHOLD &&
    dbBatchCount === 0
  ) {
    warnings.push(
      `Preview startup: ${dbQueryCount} POST /api/db/query requests with 0 batch reads — ` +
        "merge into POST /api/db/batch to cut gateway round-trips.",
    );
  }

  if (dbQueryCount >= 8) {
    warnings.push(
      `Preview startup: ${dbQueryCount} DB query requests in ~2s — verify loadData() is not firing repeatedly (debounce onDbChanged, avoid duplicate init).`,
    );
  }

  return {
    dbQueryCount,
    dbBatchCount,
    dbWriteCount,
    jobsEventsCount,
    warnings,
  };
}
