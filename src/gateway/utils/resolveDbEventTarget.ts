/**
 * Resolve jobId/dbId for jobs:db-changed SSE events from cloud host sourceId.
 */

import {
  findDataSource,
  type AppDataSourcesFile,
} from "../services/appDataSources.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DbEventTarget {
  jobId?: string;
  dbId?: string;
}

export function resolveDbEventTarget(
  config: AppDataSourcesFile,
  sourceId: string | undefined,
  appId: string,
): DbEventTarget {
  if (!sourceId || sourceId === appId) {
    const primary = config.sources.find((s) => s.role === "primary") ??
      config.sources[0];
    if (primary) {
      return {
        ...(primary.jobId ? { jobId: primary.jobId } : {}),
        ...(primary.dbId ? { dbId: primary.dbId } : {}),
      };
    }
    return {};
  }

  const source = findDataSource(config, sourceId);
  if (source) {
    return {
      ...(source.jobId ? { jobId: source.jobId } : {}),
      ...(source.dbId ? { dbId: source.dbId } : {}),
    };
  }

  if (UUID_RE.test(sourceId)) {
    return { jobId: sourceId };
  }

  return {};
}
