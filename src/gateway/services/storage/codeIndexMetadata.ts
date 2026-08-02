/**
 * Resolve human-readable mini-app titles for code indexing.
 */

import * as fs from "fs";
import * as path from "path";
import {
  getPaprAppsRoot,
  getPaprDataDir,
  getPaprJobsRoot,
} from "../../../core/utils/paprRoot.js";
import { isUuidLikeName } from "../wikiGraphHelpers.js";

interface AppsIndexEntry {
  id: string;
  title?: string;
}

let appsTitleCache: Map<string, string> | null = null;

function loadAppsTitleCache(): Map<string, string> {
  if (appsTitleCache) return appsTitleCache;

  appsTitleCache = new Map();
  const appsJsonPath = path.join(getPaprDataDir(), "apps.json");
  if (!fs.existsSync(appsJsonPath)) return appsTitleCache;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(appsJsonPath, "utf-8"));
    if (!Array.isArray(parsed)) return appsTitleCache;

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const app = entry as AppsIndexEntry;
      const title = app.title?.trim();
      if (app.id && title && title !== app.id) {
        appsTitleCache.set(app.id, title);
      }
    }
  } catch {
    // Ignore corrupt apps.json — fall back to on-disk metadata.
  }

  return appsTitleCache;
}

interface JobsIndexEntry {
  id: string;
  name?: string;
}

let jobsTitleCache: Map<string, string> | null = null;

function loadJobsTitleCache(): Map<string, string> {
  if (jobsTitleCache) return jobsTitleCache;

  jobsTitleCache = new Map();
  const jobsJsonPath = path.join(getPaprDataDir(), "jobs.json");
  if (!fs.existsSync(jobsJsonPath)) return jobsTitleCache;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(jobsJsonPath, "utf-8"));
    if (!Array.isArray(parsed)) return jobsTitleCache;

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const job = entry as JobsIndexEntry;
      const name = job.name?.trim();
      if (job.id && name && name !== job.id) {
        jobsTitleCache.set(job.id, name);
      }
    }
  } catch {
    // Ignore corrupt jobs.json.
  }

  return jobsTitleCache;
}

/** Clear cached apps.json / jobs.json titles (for tests). */
export function clearAppsTitleCache(): void {
  appsTitleCache = null;
  jobsTitleCache = null;
}

export function resolveMiniAppDisplayName(appId: string, appPath: string): string {
  const fromIndex = loadAppsTitleCache().get(appId);
  if (fromIndex) return fromIndex;

  const metadataPath = path.join(appPath, "metadata.json");
  if (fs.existsSync(metadataPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const title = (parsed as { title?: string }).title?.trim();
        if (title) return title;
      }
    } catch {
      // fall through
    }
  }

  const indexPath = path.join(appPath, "index.html");
  if (fs.existsSync(indexPath)) {
    try {
      const html = fs.readFileSync(indexPath, "utf-8");
      const match = html.match(/<title>([^<]+)<\/title>/i);
      const title = match?.[1]?.trim();
      if (title) return title;
    } catch {
      // fall through
    }
  }

  return appId;
}

export function resolveJobDisplayName(jobId: string, jobPath?: string): string {
  const fromIndex = loadJobsTitleCache().get(jobId);
  if (fromIndex) return fromIndex;

  const resolvedPath = jobPath ?? path.join(getPaprJobsRoot(), jobId);
  const jobJsonPath = path.join(resolvedPath, "job.json");
  if (fs.existsSync(jobJsonPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(jobJsonPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const name = (parsed as { name?: string }).name?.trim();
        if (name) return name;
      }
    } catch {
      // fall through
    }
  }

  return jobId;
}

export function resolveProjectIdDisplayName(
  projectId: string,
  projectType?: string,
): string {
  if (projectType === "job") {
    return resolveJobDisplayName(projectId);
  }

  const appPath = path.join(getPaprAppsRoot(), projectId);
  if (fs.existsSync(appPath)) {
    return resolveMiniAppDisplayName(projectId, appPath);
  }

  const asJob = resolveJobDisplayName(projectId);
  if (asJob !== projectId) return asJob;

  return projectId;
}

/** Resolve a UUID-like id to a human title from local apps/jobs indexes. */
export function resolveUuidToDisplayName(uuid: string): string | null {
  if (!isUuidLikeName(uuid)) return null;

  const asMiniApp = resolveProjectIdDisplayName(uuid, "mini_app");
  if (asMiniApp !== uuid) return asMiniApp;

  const asJob = resolveProjectIdDisplayName(uuid, "job");
  if (asJob !== uuid) return asJob;

  return null;
}
