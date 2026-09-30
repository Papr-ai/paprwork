/**
 * Incremental platform catalog manifest — avoids GitHub tarball scan on every publish.
 */

import fs from "fs/promises";
import path from "path";
import type { CatalogPlatform } from "../../utils/appPlatformDetection.js";

export const PLATFORM_CATALOG_MANIFEST_REL = "__papr__/platform-catalog.json";

export interface PlatformCatalogManifest {
  version: 1;
  platform: CatalogPlatform[];
  requiresDesktopForFullFunctionality: boolean;
  updatedAt: string;
}

export function platformCatalogManifestPath(appDir: string): string {
  return path.join(appDir, PLATFORM_CATALOG_MANIFEST_REL);
}

export async function readPlatformCatalogManifest(
  appDir: string,
): Promise<PlatformCatalogManifest | null> {
  try {
    const raw = await fs.readFile(platformCatalogManifestPath(appDir), "utf8");
    const parsed = JSON.parse(raw) as PlatformCatalogManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.platform)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Recompute platform badges from local sources; skip write when unchanged. */
export async function reconcilePlatformCatalogManifest(
  paprDir: string,
  appId: string,
): Promise<PlatformCatalogManifest> {
  const { detectCommunityPlatformForApp } = await import(
    "../cloudAppCompatibility.js"
  );
  const report = await detectCommunityPlatformForApp(appId);
  const manifest: PlatformCatalogManifest = {
    version: 1,
    platform: report.platform,
    requiresDesktopForFullFunctionality: report.requiresDesktopForFullFunctionality,
    updatedAt: new Date().toISOString(),
  };

  const appDir = path.join(paprDir, "apps", appId);
  const existing = await readPlatformCatalogManifest(appDir);
  if (
    existing &&
    existing.version === manifest.version &&
    existing.platform.join("|") === manifest.platform.join("|") &&
    existing.requiresDesktopForFullFunctionality ===
      manifest.requiresDesktopForFullFunctionality
  ) {
    return existing;
  }

  const manifestPath = platformCatalogManifestPath(appDir);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
