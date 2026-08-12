/**
 * Formatting and state logic for the App Files panel.
 *
 * Pure and separate from the component because the honesty rules live here: a
 * multi-GB upload is watched, and a progress line that rounds badly or invents
 * an ETA out of two samples reads as a stall. These are the parts worth
 * testing directly.
 */

import type { AppFileRow } from "../../src/gateway/services/appFiles/appFilesSchema";

/** Bytes as a human reads them. GB for anything large — "6871 MB" is unreadable. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 100 keeps "6.7 GB" precise without "6.70 GB" noise.
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Transfer rate. Same rounding rules as size, per second. */
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Time remaining, in the coarsest unit that is still useful.
 *
 * Returns null rather than guessing: an ETA computed from a fraction of a
 * second of samples swings wildly, and a number that jumps from 2 min to 4 h
 * and back is worse than no number.
 */
export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `~${Math.round(seconds)} sec`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  const hours = seconds / 3600;
  return `~${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
}

/**
 * The progress line for an upload in flight.
 *
 * Deliberately verbose: "4.2 GB / 6.7 GB · 5.3 MB/s · ~8 min" answers "is this
 * moving and when will it end" at a glance. A bare percentage answers neither.
 */
export function formatProgressLine(
  uploadedBytes: number,
  totalBytes: number,
  bytesPerSecond: number,
  etaSeconds: number | null,
): string {
  const parts = [`${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`];
  if (bytesPerSecond > 0) parts.push(formatRate(bytesPerSecond));
  const eta = formatEta(etaSeconds);
  if (eta) parts.push(eta);
  return parts.join(" · ");
}

export type FileGlyph = "filled" | "ring" | "hollow" | "slashed";

/**
 * Which of the four state glyphs a file shows.
 *
 * One glyph per state, no colour-only distinction — the state has to survive
 * being printed in greyscale or seen by someone who cannot distinguish red
 * from green.
 */
export function glyphForFile(row: AppFileRow): FileGlyph {
  if (row.upload_state === "failed") return "slashed";
  if (row.upload_state !== "verified") return "ring";
  // Verified: filled when a local copy is also present, hollow when the bytes
  // live only in the cloud. The difference matters because opening a hollow
  // file costs a download.
  return row.local_path ? "filled" : "hollow";
}

/** Plain-language state, for the row's secondary line and the glyph's title. */
export function describeFileState(row: AppFileRow): string {
  switch (row.upload_state) {
    case "verified":
      return row.local_path ? "On this Mac and in the cloud" : "In the cloud";
    case "failed":
      return "Upload failed — will resume";
    case "uploading":
      return "Uploading";
    default:
      return "Waiting to upload";
  }
}

/**
 * Bytes that could be freed by dropping local copies.
 *
 * Only verified files count. Anything else has no confirmed cloud copy, so
 * deleting the local one could destroy someone's only copy.
 */
export function reclaimableBytes(rows: readonly AppFileRow[]): number {
  return rows
    .filter((row) => row.upload_state === "verified" && row.local_path)
    .reduce((sum, row) => sum + row.size_bytes, 0);
}

/** Everything stored, for the one number in the panel header. */
export function totalBytes(rows: readonly AppFileRow[]): number {
  return rows.reduce((sum, row) => sum + row.size_bytes, 0);
}

/**
 * Whole-percent progress, or null when the file is not uploading.
 *
 * Whole numbers on purpose: a decimal that changes several times a second is
 * harder to read than one that ticks, and carries no more information.
 *
 * Never returns 100 for an upload still in flight — showing 100% while the
 * server is still verifying is the single most common way a progress
 * indicator lies, and it makes the last seconds feel broken.
 */
export function uploadPercent(row: AppFileRow): number | null {
  if (row.upload_state !== "uploading") return null;
  if (row.size_bytes <= 0) return 0;
  const percent = (row.bytes_uploaded / row.size_bytes) * 100;
  return Math.min(99, Math.floor(percent));
}

/** True when a file is safe to evict — verified, with a local copy to drop. */
export function canEvict(row: AppFileRow): boolean {
  return row.upload_state === "verified" && Boolean(row.local_path);
}
