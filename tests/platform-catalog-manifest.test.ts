import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  PLATFORM_CATALOG_MANIFEST_REL,
  readPlatformCatalogManifest,
  reconcilePlatformCatalogManifest,
} from "../src/gateway/services/syncV3/platformCatalogManifest.js";

describe("platformCatalogManifest", () => {
  const ws = useIsolatedPaprWorkspace("papr-manifest");

  it("writes and reads manifest under __papr__/", async () => {
    const paprDir = ws.paprHome;
    const appId = "test-app-id";
    const appDir = path.join(paprDir, "apps", appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "index.html"),
      "<html><body>Hello</body></html>",
      "utf8",
    );

    const manifest = await reconcilePlatformCatalogManifest(paprDir, appId);
    expect(manifest.version).toBe(1);
    expect(manifest.platform.length).toBeGreaterThan(0);
    expect(manifest.updatedAt).toBeTruthy();

    const manifestPath = path.join(appDir, PLATFORM_CATALOG_MANIFEST_REL);
    await fs.access(manifestPath);

    const roundTrip = await readPlatformCatalogManifest(appDir);
    expect(roundTrip?.platform).toEqual(manifest.platform);
    expect(roundTrip?.requiresDesktopForFullFunctionality).toBe(
      manifest.requiresDesktopForFullFunctionality,
    );
  });

  it("skips manifest rewrite when platform badges are unchanged", async () => {
    const paprDir = ws.paprHome;
    const appId = "stable-manifest-app";
    const appDir = path.join(paprDir, "apps", appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "index.html"), "<html></html>", "utf8");

    const first = await reconcilePlatformCatalogManifest(paprDir, appId);
    const manifestPath = path.join(appDir, PLATFORM_CATALOG_MANIFEST_REL);
    const firstRaw = await fs.readFile(manifestPath, "utf8");

    const second = await reconcilePlatformCatalogManifest(paprDir, appId);
    const secondRaw = await fs.readFile(manifestPath, "utf8");

    expect(second.platform).toEqual(first.platform);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(secondRaw).toBe(firstRaw);
  });
});
