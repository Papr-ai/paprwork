/**
 * Per-app cache revision — busts Cloud App Host caches only for the app that synced.
 *
 * Unlike repo-wide `data/cloud-repo-head.txt`, this marker lives in each app folder
 * and updates only when that app is prepared for cloud git sync.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const PAPR_APP_CLOUD_REVISION_PATH = ".papr-cloud-revision";

export function parseAppCloudRevisionContent(content: string): string {
  const line = content.trim().split("\n")[0]?.trim() ?? "";
  if (!line) {
    return "0";
  }
  return line.toLowerCase();
}

/** Content hash of dist/app.js — stable when the bundle is unchanged (Vercel-style). */
export function distBundleRevisionHash(distAppJsContent: string): string {
  return createHash("sha256").update(distAppJsContent).digest("hex").slice(0, 16);
}

/**
 * Revision for a whole app: dist/app.js plus the backend files Cloud App Host caches
 * under it (manifest + bundle.json, which carries every handler's sha256).
 *
 * Hashing dist/app.js alone meant a backend-only edit left the revision unchanged, so
 * the host kept serving the old handlers from its revision-keyed cache.
 * Apps without a backend keep the plain dist hash, so their revision does not change.
 */
export function appRevisionHash(appDir: string): string | null {
  const distPath = path.join(appDir, "dist", "app.js");
  if (!existsSync(distPath)) {
    return null;
  }
  const dist = readFileSync(distPath, "utf8");
  const backendParts = ["manifest.json", "bundle.json"]
    .map((name) => path.join(appDir, "backend", name))
    .filter((file) => existsSync(file))
    .map((file) => `${path.basename(file)}\n${readFileSync(file, "utf8")}`);
  if (backendParts.length === 0) {
    return distBundleRevisionHash(dist);
  }
  return distBundleRevisionHash([dist, ...backendParts].join("\n--backend--\n"));
}

export function writeAppCloudRevisionMarker(appDir: string): void {
  const revision =
    appRevisionHash(appDir) ??
    createHash("sha256").update(`no-dist:${Date.now()}`).digest("hex").slice(0, 16);
  writeFileSync(
    path.join(appDir, PAPR_APP_CLOUD_REVISION_PATH),
    `${revision}\n`,
    "utf8",
  );
}
