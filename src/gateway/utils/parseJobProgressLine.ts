/**
 * Parse structured progress lines emitted by jobs to stdout.
 *
 * Format: PAPR_PROGRESS {"event":"name","payload":{...}}
 */

import {
  PAPR_PROGRESS_PREFIX,
  type JobProgressData,
} from "../../core/types/jobEvents.js";

export interface ParsedJobProgress {
  event: string;
  payload: Record<string, unknown>;
}

export function parseJobProgressLine(line: string): ParsedJobProgress | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PAPR_PROGRESS_PREFIX)) {
    return null;
  }
  const jsonPart = trimmed.slice(PAPR_PROGRESS_PREFIX.length).trim();
  if (!jsonPart.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonPart) as {
      event?: unknown;
      payload?: unknown;
    };
    if (typeof parsed.event !== "string" || parsed.event.length === 0) {
      return null;
    }
    const payload =
      parsed.payload !== null &&
      typeof parsed.payload === "object" &&
      !Array.isArray(parsed.payload)
        ? (parsed.payload as Record<string, unknown>)
        : {};
    return { event: parsed.event, payload };
  } catch {
    return null;
  }
}

export function toJobProgressData(
  jobId: string,
  parsed: ParsedJobProgress,
): JobProgressData {
  return {
    jobId,
    event: parsed.event,
    payload: parsed.payload,
  };
}
