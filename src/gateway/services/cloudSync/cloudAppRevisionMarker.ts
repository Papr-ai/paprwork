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
 * Claude cards (dist/cards/*) are published files too. The host caches every published file
 * under this marker, so a card-only change (new card, same dist/app.js) must move it or the
 * host keeps serving the old card. Apps without cards keep the plain app.js hash.
 */
export function appCloudRevisionHash(appDir: string, distAppJsContent: string): string {
  const cardsDir = path.join(appDir, "dist", "cards");
  const cards = existsSync(cardsDir)
    ? readdirSync(cardsDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
    : [];
  if (cards.length === 0) return distBundleRevisionHash(distAppJsContent);
  const h = createHash("sha256").update(distAppJsContent);
  for (const name of cards) h.update(`\0cards/${name}\0`).update(readFileSync(path.join(cardsDir, name)));
  return h.digest("hex").slice(0, 16);
}

export function writeAppCloudRevisionMarker(appDir: string): void {
  const distPath = path.join(appDir, "dist", "app.js");
  let revision: string;
  if (existsSync(distPath)) {
    revision = appCloudRevisionHash(appDir, readFileSync(distPath, "utf8"));
  } else {
    revision = createHash("sha256")
      .update(`no-dist:${Date.now()}`)
      .digest("hex")
      .slice(0, 16);
  }
  writeFileSync(
    path.join(appDir, PAPR_APP_CLOUD_REVISION_PATH),
    `${revision}\n`,
    "utf8",
  );
}
