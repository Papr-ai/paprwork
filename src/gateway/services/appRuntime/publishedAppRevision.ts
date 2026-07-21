/**
 * Published app revision — ties git repo head to dist bundle hash for cache busting.
 */

import { createHash } from "node:crypto";
import type { AppRuntimeRouteAuth } from "./types.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import {
  CLOUD_REPO_HEAD_RELATIVE_PATH,
  parseCloudRepoHeadContent,
} from "../cloudSync/cloudRepoHeadMarker.js";

export const PAPR_APP_REVISION_META_NAME = "papr-app-revision";

export function formatPublishedAppRevision(
  repoHead: string,
  appJsContent?: string | null,
): string | null {
  if (appJsContent) {
    const appJsHash = createHash("sha256")
      .update(appJsContent)
      .digest("hex")
      .slice(0, 16);
    return `${repoHead}:${appJsHash}`;
  }
  return repoHead === "0" ? null : repoHead;
}

export async function resolvePublishedAppRevision(
  auth: AppRuntimeRouteAuth,
  opts?: { bypassFresh?: boolean },
): Promise<string | null> {
  const fetchOpts = opts?.bypassFresh ? { bypassFresh: true as const } : undefined;

  const repoHeadFile = await fetchCachedRuntimeRepoFile(
    auth,
    CLOUD_REPO_HEAD_RELATIVE_PATH,
    fetchOpts,
  );
  const repoHead = repoHeadFile
    ? parseCloudRepoHeadContent(repoHeadFile.content)
    : "0";

  const distBundle = await fetchCachedRuntimeRepoFile(auth, "dist/app.js", fetchOpts);
  return formatPublishedAppRevision(repoHead, distBundle?.content ?? null);
}

export function injectPaprAppRevisionMeta(html: string, revision: string): string {
  const escaped = revision.replace(/"/g, "&quot;");
  const tag = `<meta name="${PAPR_APP_REVISION_META_NAME}" content="${escaped}">`;
  if (html.includes(`name="${PAPR_APP_REVISION_META_NAME}"`)) {
    return html.replace(
      new RegExp(
        `<meta name="${PAPR_APP_REVISION_META_NAME}" content="[^"]*">`,
      ),
      tag,
    );
  }
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${tag}`);
  }
  if (/<head\s[^>]*>/i.test(html)) {
    return html.replace(/<head\s[^>]*>/i, (match) => `${match}\n  ${tag}`);
  }
  return `${tag}\n${html}`;
}
