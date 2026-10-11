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
 * Revision of everything the cloud host serves from dist/: the bundle plus Claude
 * cards (dist/cards/*). A card-only edit must bump it, or the host keeps serving the
 * old card under the unchanged key. Apps without cards hash exactly as before.
 */
export function distRevisionHash(appDir: string): string | null {
  const distPath = path.join(appDir, "dist", "app.js");
  if (!existsSync(distPath)) return null;
  const appJs = readFileSync(distPath, "utf8");
  const cardsDir = path.join(appDir, "dist", "cards");
  let cards: string[] = [];
  try {
    cards = readdirSync(cardsDir).filter((f) => /\.(html|json)$/.test(f)).sort();
  } catch {
    cards = [];
  }
  if (cards.length === 0) return distBundleRevisionHash(appJs);
  const h = createHash("sha256").update(appJs);
  for (const f of cards) h.update(`\0${f}\0`).update(readFileSync(path.join(cardsDir, f)));
  return h.digest("hex").slice(0, 16);
}

export function writeAppCloudRevisionMarker(appDir: string): void {
  let revision = distRevisionHash(appDir);
  if (!revision) {
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
