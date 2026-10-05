/**
 * `{{papr.app_id}}` in job instructions and commands.
 *
 * Agent-job prompts used to carry the app's UUID as literal text, so every
 * install had to rewrite it and every proposal had to rewrite it back (and a
 * wrong guess swapped an owner's job to another app). Instead the text holds
 * the placeholder and the runner fills it in per run — the same idea as
 * `{{papr.owner_user_id}}` in migrations. Nothing is rewritten at install or
 * proposal time; ids of OTHER apps stay exactly as written.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { STANDALONE_APP_ID } from "./appIds.js";

export const APP_ID_PLACEHOLDER = "{{papr.app_id}}";

export function hasAppIdPlaceholder(text: string): boolean {
  return text.includes(APP_ID_PLACEHOLDER);
}

/** The app a job runs for: its first real (non-standalone) app id. */
export function primaryAppId(appIds: readonly string[] | undefined): string | undefined {
  return (appIds ?? []).map((a) => a.trim()).find((a) => a && a !== STANDALONE_APP_ID);
}

/** Fill the placeholder for this run. No app id -> text is returned unchanged. */
export function substituteAppIdPlaceholder(text: string, appIds: readonly string[] | undefined): string {
  if (!hasAppIdPlaceholder(text)) return text;
  const appId = primaryAppId(appIds);
  return appId ? text.split(APP_ID_PLACEHOLDER).join(appId) : text;
}

/** Exact-match conversion of the app's OWN id to the placeholder (publish time). */
export function portableAppIdInText(text: string, ownAppId: string): { text: string; replaced: number } {
  const id = ownAppId.trim();
  if (!id || !text.includes(id)) return { text, replaced: 0 };
  const parts = text.split(id);
  return { text: parts.join(APP_ID_PLACEHOLDER), replaced: parts.length - 1 };
}

/**
 * Does this job belong to the app being proposed? Reads the job's own appIds.
 * Unreadable / missing job.json -> true (never drop a job because of a read error).
 */
export async function jobOwnedByApp(jobDir: string, appId: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(jobDir, "job.json"), "utf8")) as {
      appIds?: unknown;
    };
    if (!Array.isArray(parsed.appIds)) return true;
    return parsed.appIds.map(String).includes(appId);
  } catch {
    return true;
  }
}
