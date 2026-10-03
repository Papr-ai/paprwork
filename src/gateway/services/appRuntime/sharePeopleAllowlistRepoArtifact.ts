/**
 * Per-app Git artifact for audience "people" allowlists.
 *
 * Cloud App Host cannot read workspace cloud-publish-prefs.json (wrong repo) or
 * owner-only GET /v1/cloud/apps/publish (host key → 401). This file lives in
 * the app's own repo and is fetched via runtime/repo-file like data-sources.json.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { CloudPublishAppPrefs } from "../cloudPublishPrefs.js";
import { memoryShareAllowlistBodyFromPrefs } from "../cloudShareAllowlistMemory.js";
import type { SharePeopleAllowlist } from "./cloudAppPeopleAccess.js";
import { sharePeopleAllowlistFromFields } from "./sharePeopleAllowlistFields.js";

export const SHARE_PEOPLE_ALLOWLIST_REPO_PATH = "data/share-people-allowlist.json";

export function parseSharePeopleAllowlistRepoFile(
  rawJson: string,
): SharePeopleAllowlist | undefined {
  try {
    const parsed = JSON.parse(rawJson) as Pick<
      CloudPublishAppPrefs,
      "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
    >;
    return sharePeopleAllowlistFromFields(parsed);
  } catch {
    return undefined;
  }
}

export function sharePeopleAllowlistRepoJson(
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
): string {
  const body = memoryShareAllowlistBodyFromPrefs(prefs);
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Write allowlist into the app tree (synced to Git on next pushAppNow). */
export async function writeSharePeopleAllowlistRepoFile(
  appDir: string,
  prefs: Pick<
    CloudPublishAppPrefs,
    "allowedUserIds" | "allowedEmails" | "allowedEmailDomains"
  >,
): Promise<void> {
  const target = path.join(appDir, SHARE_PEOPLE_ALLOWLIST_REPO_PATH);
  const next = sharePeopleAllowlistRepoJson(prefs);
  // Sync change detection is mtime-based: rewriting identical bytes after a
  // publish would flip the app to "Unpublished changes" with nothing to publish.
  const current = await readFile(target, "utf8").catch(() => null);
  if (current === next) return;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, next, "utf8");
}
