/**
 * Published app revision — ties git repo head to dist bundle hash for cache busting.
 */

import { createHash } from "node:crypto";
import type { AppRuntimeRouteAuth } from "./types.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import {
  PAPR_APP_CLOUD_REVISION_PATH,
  parseAppCloudRevisionContent,
} from "../cloudSync/cloudAppRevisionMarker.js";
import {
  CLOUD_REPO_HEAD_RELATIVE_PATH,
  parseCloudRepoHeadContent,
} from "../cloudSync/cloudRepoHeadMarker.js";
import {
  PAPR_APP_META_RELATIVE_PATH,
  parseCloudAppMetaRevision,
} from "../cloudSync/cloudAppMeta.js";

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

  const [markerFile, metaFile, repoHeadFile, distBundle] = await Promise.all([
    fetchCachedRuntimeRepoFile(auth, PAPR_APP_CLOUD_REVISION_PATH, fetchOpts),
    fetchCachedRuntimeRepoFile(auth, PAPR_APP_META_RELATIVE_PATH, fetchOpts),
    fetchCachedRuntimeRepoFile(auth, CLOUD_REPO_HEAD_RELATIVE_PATH, fetchOpts),
    fetchCachedRuntimeRepoFile(auth, "dist/app.js", fetchOpts),
  ]);
  if (markerFile) {
    const revision = parseAppCloudRevisionContent(markerFile.content);
    return revision === "0" ? null : revision;
  }
  if (metaFile) {
    const meta = parseCloudAppMetaRevision(metaFile.content);
    if (meta?.distRevision && meta.distRevision !== "0") {
      return meta.distRevision;
    }
  }
  const repoHead = repoHeadFile
    ? parseCloudRepoHeadContent(repoHeadFile.content)
    : "0";

  return formatPublishedAppRevision(repoHead, distBundle?.content ?? null);
}

export interface IndexHtmlRepoPrefetch {
  indexHtml: { content: string; contentType: string } | null;
  distJs: { content: string; contentType: string } | null;
  distCss: { content: string; contentType: string } | null;
  revision: string | null;
}

/** Parallel fetch of everything needed to assemble index.html. */
export async function prefetchIndexHtmlRepoFiles(
  auth: AppRuntimeRouteAuth,
  opts?: { bypassFresh?: boolean },
): Promise<IndexHtmlRepoPrefetch> {
  const fetchOpts = opts?.bypassFresh ? { bypassFresh: true as const } : undefined;
  const [indexHtml, distJs, distCss, revision] = await Promise.all([
    fetchCachedRuntimeRepoFile(auth, "index.html", fetchOpts),
    fetchCachedRuntimeRepoFile(auth, "dist/app.js", fetchOpts),
    fetchCachedRuntimeRepoFile(auth, "dist/app.css", fetchOpts),
    resolvePublishedAppRevision(auth, fetchOpts),
  ]);
  return { indexHtml, distJs, distCss, revision };
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
