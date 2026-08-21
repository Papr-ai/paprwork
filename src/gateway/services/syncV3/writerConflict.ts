/**
 * Writer 409 conflict handling — invalidate OID cache + surface telemetry.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import type { AppRepoOpsConflictResponse } from "../../../core/types/appRepoWriterOps.js";
import { invalidateCachedPath } from "./OidCache.js";

export interface WriterConflictEvent {
  appId: string;
  path: string;
  expectedParentHash: string;
  actualBlobOid: string | null;
  at: string;
}

const recentConflicts: WriterConflictEvent[] = [];
const MAX_RECENT_CONFLICTS = 50;

async function persistConflictEvent(event: WriterConflictEvent): Promise<void> {
  try {
    const dir = path.join(getPaprRoot(), "data");
    await mkdir(dir, { recursive: true });
    await appendFile(
      path.join(dir, "writer-conflicts.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  } catch {
    /* non-fatal */
  }
}

export async function invalidateWriterConflictPaths(
  appId: string,
  artifacts: AppRepoOpsConflictResponse["artifacts"],
): Promise<void> {
  for (const artifact of artifacts) {
    await invalidateCachedPath(appId, artifact.path);
    const event: WriterConflictEvent = {
      appId,
      path: artifact.path,
      expectedParentHash: artifact.expectedParentHash,
      actualBlobOid: artifact.actualBlobOid,
      at: new Date().toISOString(),
    };
    recentConflicts.push(event);
    void persistConflictEvent(event);
  }
  while (recentConflicts.length > MAX_RECENT_CONFLICTS) {
    recentConflicts.shift();
  }
}

export function listRecentWriterConflicts(appId?: string): WriterConflictEvent[] {
  if (!appId) {
    return [...recentConflicts];
  }
  return recentConflicts.filter((event) => event.appId === appId);
}

export function clearWriterConflictsForTests(): void {
  recentConflicts.length = 0;
}
