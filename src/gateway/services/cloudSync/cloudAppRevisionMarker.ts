/**
 * Per-app cache revision — busts Cloud App Host caches only for the app that synced.
 *
 * Unlike repo-wide `data/cloud-repo-head.txt`, this marker lives in each app folder
 * and updates only when that app is prepared for cloud git sync.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Revision for a whole app. Cloud App Host caches every published file under this
 * marker, so anything it serves must move it:
 * - dist/app.js
 * - backend manifest + bundle.json (carries every handler's sha256) — a backend-only
 *   edit must not keep serving old handlers
 * - Claude cards (dist/cards/*) — a card-only change must not keep serving the old card
 * Apps with neither backend nor cards keep the plain dist hash, so their revision is stable.
 */
export function appRevisionHash(appDir: string): string | null {
  const distPath = path.join(appDir, "dist", "app.js");
  if (!existsSync(distPath)) {
    return null;
  }
  return appCloudRevisionHash(appDir, readFileSync(distPath, "utf8"));
}

export function appCloudRevisionHash(appDir: string, distAppJsContent: string): string {
  const backendParts = ["manifest.json", "bundle.json"]
    .map((name) => path.join(appDir, "backend", name))
    .filter((file) => existsSync(file))
    .map((file) => `${path.basename(file)}\n${readFileSync(file, "utf8")}`);
  const cardsDir = path.join(appDir, "dist", "cards");
  const cards = existsSync(cardsDir)
    ? readdirSync(cardsDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
    : [];
  if (backendParts.length === 0 && cards.length === 0) {
    return distBundleRevisionHash(distAppJsContent);
  }
  // Same backend-only hash as before cards existed (no needless revision churn).
  const base =
    backendParts.length === 0
      ? distAppJsContent
      : [distAppJsContent, ...backendParts].join("\n--backend--\n");
  if (cards.length === 0) return distBundleRevisionHash(base);
  const h = createHash("sha256").update(base);
  for (const name of cards) h.update(`\0cards/${name}\0`).update(readFileSync(path.join(cardsDir, name)));
  return h.digest("hex").slice(0, 16);
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
