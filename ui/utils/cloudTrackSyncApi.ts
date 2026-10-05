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
  /** Both sides edited different lines; combined automatically. */
  mergedFiles?: string[];
  conflictFiles: string[];
  skippedFiles: string[];
  failedFiles?: string[];
  /** Overlapping files resolved to the publisher's version on request. */
  takenTheirsFiles?: string[];
  /** dryRun only: what Get updates would bring. */
  incoming?: Array<{ path: string; change: "added" | "edited"; merged?: boolean; conflict?: boolean }>;
  lastSyncedAt: string;
}

/**
 * Pull the publisher's code. `fileResolutions` answers overlapping files one
 * by one (theirs overwrites, mine keeps); `dryRun` only reports what would
 * happen — the status panel uses it to list the update before applying.
 */
export async function pullTrackUpstream(
  appId: string,
  options: { fileResolutions?: Record<string, "mine" | "theirs">; dryRun?: boolean } = {},
): Promise<TrackSyncResult> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/track-sync/${encodeURIComponent(appId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    },
  );
  const body = (await res.json()) as TrackSyncResult & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Pull failed (${res.status})`);
  }
  return body;
}

/** Discard my edits: overwrite locally edited files with the publisher's code. */
export async function discardTrackLocalEdits(appId: string): Promise<TrackSyncResult> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/track-sync/${encodeURIComponent(appId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discardLocal: true }),
    },
  );
  const body = (await res.json()) as TrackSyncResult & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Discard failed (${res.status})`);
  return body;
}

/** Duplicate as my own app: a fork install of the same source (own code + fresh data). */
export async function duplicateAsOwnApp(source: {
  namespaceId: string;
  slug: string;
  /** Name for the new app, e.g. "Launch HQ (my copy)". */
  title?: string;
}): Promise<{ appId: string; title?: string }> {
  const res = await fetch(`${GATEWAY}/api/cloud/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      namespaceId: source.namespaceId,
      slug: source.slug,
      mode: "fork",
      ...(source.title ? { title: source.title } : {}),
    }),
  });
  const body = (await res.json()) as { app?: { id: string; title?: string }; error?: string };
  if (!res.ok || !body.app?.id) throw new Error(body.error ?? `Duplicate failed (${res.status})`);
  return { appId: body.app.id, title: body.app.title };
}

/** Collaborator edits vs last upstream sync. `known: false` = cannot tell (keep Propose enabled). */
export async function fetchTrackLocalEdits(
  appId: string,
): Promise<{ known: boolean; files: string[]; unproposed?: string[] }> {
  try {
    const res = await fetch(
      `${GATEWAY}/api/cloud/track-sync/${encodeURIComponent(appId)}/local-edits`,
    );
    if (!res.ok) return { known: false, files: [] };
    return (await res.json()) as { known: boolean; files: string[]; unproposed?: string[] };
  } catch {
    return { known: false, files: [] };
  }
}

export function formatTrackSyncSummary(result: TrackSyncResult): string {
  const parts: string[] = [];
  if (result.updatedFiles.length > 0) {
    parts.push(
      `Updated ${result.updatedFiles.length} file${result.updatedFiles.length === 1 ? "" : "s"}`,
    );
  }
  const merged = result.mergedFiles?.length ?? 0;
  if (merged > 0) {
    parts.push(`Merged ${merged} file${merged === 1 ? "" : "s"} with your edits`);
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

/** v5 Detach: stop following the original. Refused (409) while on team data. */
export async function detachFromOriginal(appId: string): Promise<{ detached: boolean }> {
  const res = await fetch(
    `${GATEWAY}/api/cloud/track-sync/${encodeURIComponent(appId)}/detach`,
    { method: "POST" },
  );
  const body = (await res.json()) as { detached: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Detach failed (${res.status})`);
  return body;
}

/** Plain-language reason a "Duplicate as my own app" attempt failed. */
export function describeDuplicateError(message: string): string {
  if (/code install is not enabled|lack permission|\(403\)/i.test(message)) {
    return "The owner hasn't allowed copies of this app. Ask them to turn on \"Edit the code\" in Share, then try again.";
  }
  if (/fetch failed|network|ECONN/i.test(message)) {
    return "Couldn't reach Papr Cloud. Check your connection and try again.";
  }
  return `Couldn't duplicate: ${message.slice(0, 160)}`;
}

export interface CodeChange {
  path: string;
  change: "added" | "edited" | "removed";
  /** A removal held until the user confirms (more than 10 at once). */
  needsConfirm?: boolean;
}

export interface CodeChangeSet {
  changes: CodeChange[];
  /** On the web, not on this computer, never synced from here. */
  webOnly: string[];
}

/** Files Publish would send (app files, jobs, schema files). */
export async function fetchLocalCodeChanges(appId: string): Promise<CodeChangeSet | null> {
  try {
    const res = await fetch(`${GATEWAY}/api/apps/${encodeURIComponent(appId)}/code-changes`);
    if (!res.ok) return null;
    const body = (await res.json()) as { changes?: CodeChange[]; webOnly?: string[] };
    return { changes: body.changes ?? [], webOnly: body.webOnly ?? [] };
  } catch {
    return null;
  }
}

/** Confirm removing these files from the web; the next Publish deletes them. */
export async function confirmWebDeletes(appId: string, paths: string[]): Promise<string[]> {
  const res = await fetch(`${GATEWAY}/api/apps/${encodeURIComponent(appId)}/confirm-web-deletes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) throw new Error(`Couldn't confirm removal (${res.status})`);
  const body = (await res.json()) as { approved?: string[] };
  return body.approved ?? [];
}

export interface OwnUpdatePreview {
  incoming: Array<{ path: string; change: "added" | "edited" | "removed"; merged?: boolean; conflict?: boolean }>;
  conflictFiles: string[];
}

/** Dry-run Get updates for my own app's web copy. null = nothing to get / unknown. */
export async function previewOwnUpdate(appId: string): Promise<OwnUpdatePreview | null> {
  try {
    const res = await fetch(`${GATEWAY}/api/apps/${encodeURIComponent(appId)}/sync-from-cloud`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      code?: { skipped?: boolean; incoming?: OwnUpdatePreview["incoming"]; conflictFiles?: string[] };
    };
    if (!body.code || body.code.skipped) return null;
    return { incoming: body.code.incoming ?? [], conflictFiles: body.code.conflictFiles ?? [] };
  } catch {
    return null;
  }
}
