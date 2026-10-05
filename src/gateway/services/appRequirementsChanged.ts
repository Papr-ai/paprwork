/**
 * Tell the UI an app's API-key catalog may have changed, so the share bar's
 * missing-key chip and Share → API keys re-check instead of waiting for focus.
 *
 * The catalog is requirements.json + backend/manifest.json keys + linked
 * jobs' requiredKeys and ${KEY} refs, so any of those changing triggers this.
 */

import * as fs from "fs";
import * as path from "path";
import { TreeWatcher } from "./TreeWatcher.js";

const timers = new Map<string, NodeJS.Timeout>();

/** Debounced per app ("" = unknown app: every open share bar re-checks). */
export function notifyAppRequirementsChanged(appId?: string): void {
  const key = appId ?? "";
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void import("../websocket/index.js")
        .then(({ broadcast }) => {
          if (typeof broadcast !== "function") return;
          broadcast({ type: "app:requirements-changed", data: appId ? { appId } : {} });
        })
        .catch(() => {});
    }, 400),
  );
}

/** App files that feed the key catalog. */
export function isAppRequirementsSource(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, "/");
  return p === "requirements.json" || p === "backend/manifest.json";
}

function appIdsOfJob(jobJsonPath: string): string[] {
  try {
    const job = JSON.parse(fs.readFileSync(jobJsonPath, "utf8")) as { appIds?: unknown };
    return Array.isArray(job.appIds) ? job.appIds.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Watch Jobs/{id}/job.json (requiredKeys / command edits by update_job, the
 * agent or a git pull). One recursive OS handle; everything else is ignored.
 */
export function startJobKeysWatcher(jobsDir: string): TreeWatcher | null {
  if (!fs.existsSync(jobsDir)) return null;
  const watcher = new TreeWatcher({
    roots: [jobsDir],
    recursive: true,
    settleMs: 300,
    ignore: (abs) => {
      const rel = path.relative(jobsDir, abs).split(path.sep);
      return !(rel.length === 1 || (rel.length === 2 && rel[1] === "job.json"));
    },
    onEvent: (event) => {
      if (path.basename(event.path) !== "job.json") return;
      const appIds = event.type === "unlink" ? [] : appIdsOfJob(event.path);
      // A dependency-only job has no appIds of its own: let every bar re-check.
      if (appIds.length === 0) notifyAppRequirementsChanged();
      for (const id of appIds) notifyAppRequirementsChanged(id);
    },
    onError: (error) => {
      console.warn("[AppRequirements] job.json watcher error:", error?.message ?? String(error));
    },
  });
  return watcher.rootCount > 0 ? watcher : null;
}
