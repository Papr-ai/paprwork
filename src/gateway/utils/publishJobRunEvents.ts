/**
 * Publish job lifecycle + stdout progress events to the shared hub.
 */

import type { JobStatusChangedData } from "../../core/types/jobEvents.js";
import { getJobEventHub } from "../services/JobEventHub.js";
import {
  parseJobProgressLine,
  toJobProgressData,
} from "./parseJobProgressLine.js";

export function publishJobStatusChanged(data: JobStatusChangedData): void {
  getJobEventHub().publish({
    type: "jobs:status-changed",
    data,
  });
}

export function publishJobOutputProgress(
  jobId: string,
  output: string | undefined,
): void {
  if (!output) {
    return;
  }
  const hub = getJobEventHub();
  for (const line of output.split("\n")) {
    const progress = parseJobProgressLine(line);
    if (progress) {
      hub.publish({
        type: "jobs:progress",
        data: toJobProgressData(jobId, progress),
      });
    }
  }
}

export function publishDbChanged(
  target: string | { jobId?: string; dbId?: string; tables?: string[] },
  tables: string[] = [],
): void {
  const data =
    typeof target === "string"
      ? { jobId: target, tables }
      : {
          ...(target.jobId ? { jobId: target.jobId } : {}),
          ...(target.dbId ? { dbId: target.dbId } : {}),
          tables: target.tables ?? [],
        };

  if (!data.jobId && !data.dbId) {
    return;
  }

  getJobEventHub().publish({
    type: "jobs:db-changed",
    data,
  });
}
