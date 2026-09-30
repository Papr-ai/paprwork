/**
 * Remap registry dbIds on job records after fork / namespace copy.
 */

import type { JobRecord } from "../jobs/types.js";

export const REGISTRY_DB_ID_PATTERN = /\bdb-[0-9a-f]{8}\b/gi;

export function remapDbIdsInText(
  text: string,
  dbIdRemap: ReadonlyMap<string, string>,
): string {
  if (dbIdRemap.size === 0 || !text) {
    return text;
  }
  return text.replace(REGISTRY_DB_ID_PATTERN, (match) => {
    const mapped = dbIdRemap.get(match);
    return mapped ?? match;
  });
}

export function remapWriteDbIds(
  writeDbIds: readonly string[] | undefined,
  dbIdRemap: ReadonlyMap<string, string>,
): readonly string[] | undefined {
  if (!writeDbIds || writeDbIds.length === 0 || dbIdRemap.size === 0) {
    return writeDbIds ? [...writeDbIds] : undefined;
  }
  let changed = false;
  const next = writeDbIds.map((id) => {
    const trimmed = id.trim();
    const mapped = dbIdRemap.get(trimmed);
    if (mapped && mapped !== trimmed) {
      changed = true;
      return mapped;
    }
    return id;
  });
  return changed ? next : writeDbIds;
}

export function remapJobRecordDbIds(
  job: JobRecord,
  dbIdRemap: ReadonlyMap<string, string>,
): JobRecord {
  if (dbIdRemap.size === 0) {
    return job;
  }

  const writeDbIds = remapWriteDbIds(job.writeDbIds, dbIdRemap);
  const command =
    job.command !== undefined
      ? remapDbIdsInText(job.command, dbIdRemap)
      : undefined;

  if (
    writeDbIds === job.writeDbIds &&
    command === job.command
  ) {
    return job;
  }

  return {
    ...job,
    ...(writeDbIds !== undefined ? { writeDbIds: [...writeDbIds] } : {}),
    ...(command !== undefined ? { command } : {}),
    updatedAt: new Date().toISOString(),
  };
}
