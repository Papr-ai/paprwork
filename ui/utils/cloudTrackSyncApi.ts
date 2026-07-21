/**
 * Manual upstream pull for track-mode cloud installs.
 */

const GATEWAY =
  typeof import.meta !== "undefined" &&
  import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export interface TrackSyncResult {
  appId: string;
  updatedFiles: string[];
  conflictFiles: string[];
  skippedFiles: string[];
  lastSyncedAt: string;
}

export async function pullTrackUpstream(appId: string): Promise<TrackSyncResult> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/track-sync/${encodeURIComponent(appId)}`,
    { method: "POST" },
  );
  const body = (await res.json()) as TrackSyncResult & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Pull failed (${res.status})`);
  }
  return body;
}

export function formatTrackSyncSummary(result: TrackSyncResult): string {
  const parts: string[] = [];
  if (result.updatedFiles.length > 0) {
    parts.push(
      `Updated ${result.updatedFiles.length} file${result.updatedFiles.length === 1 ? "" : "s"}`,
    );
  }
  if (result.conflictFiles.length > 0) {
    parts.push(
      `${result.conflictFiles.length} conflict${result.conflictFiles.length === 1 ? "" : "s"} (kept your edits)`,
    );
  }
  if (parts.length === 0) {
    return "Already up to date with the publisher";
  }
  return parts.join(" · ");
}

export function formatLastSyncedAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
