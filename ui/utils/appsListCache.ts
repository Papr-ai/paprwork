/**
 * Last-known My apps list, kept across launches so the Apps page paints
 * instantly from cache while app:list refreshes in the background.
 *
 * Stored per workspace (org:namespace). Before the active workspace is known
 * (cold launch) the most recently written workspace is used — the same one the
 * app reopens into. The gateway list always replaces it moments later.
 */
import type { Artifact } from "../stores/artifactsStore";

const PREFIX = "papr-apps-list:v1:";
const LAST = "papr-apps-list:v1:last";

interface Entry {
  apps: Artifact[];
  savedAt: number;
}

export function readAppsListCache(workspaceKey: string | null): Artifact[] | null {
  try {
    const key = workspaceKey ?? localStorage.getItem(LAST);
    if (!key) return null;
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Entry>;
    return Array.isArray(parsed.apps) && parsed.apps.length > 0 ? parsed.apps : null;
  } catch {
    return null;
  }
}

export function writeAppsListCache(workspaceKey: string | null, apps: Artifact[]): void {
  if (!workspaceKey) return;
  try {
    const entry: Entry = { apps: apps.filter((a) => a.type === "app"), savedAt: Date.now() };
    localStorage.setItem(PREFIX + workspaceKey, JSON.stringify(entry));
    localStorage.setItem(LAST, workspaceKey);
  } catch {
    /* quota / private mode — the page just loads the slow way */
  }
}
