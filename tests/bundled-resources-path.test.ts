import path from "path";
import { describe, expect, test } from "vitest";
import { resolveBundledResourcesDir } from "../src/core/utils/bundledResourcesPath.js";

describe("resolveBundledResourcesDir", () => {
  const servicesDir = path.join(process.cwd(), "dist/gateway/services");

  test("finds default-apps under dist/ in dev builds", async () => {
    const resolved = await resolveBundledResourcesDir(
      servicesDir,
      "resources/default-apps",
    );
    expect(resolved).toBeTruthy();
    expect(resolved).toContain(`${path.sep}default-apps`);
  });

  test("finds default-jobs under dist/ in dev builds", async () => {
    const resolved = await resolveBundledResourcesDir(
      servicesDir,
      "resources/default-jobs",
    );
    expect(resolved).toBeTruthy();
    expect(resolved).toContain(`${path.sep}default-jobs`);
  });

  test("returns null when bundled resources are missing", async () => {
    const resolved = await resolveBundledResourcesDir(
      servicesDir,
      "resources/does-not-exist",
    );
    expect(resolved).toBeNull();
  });

  test("prefers app.asar.unpacked when ASAR parent dir is not listable", async () => {
    const asarServicesDir =
      "/Applications/Papr Work.app/Contents/Resources/app.asar/dist/gateway/services";
    const resolved = await resolveBundledResourcesDir(
      asarServicesDir,
      "resources/default-apps",
    );
    if (!resolved) {
      return;
    }
    expect(resolved).toContain("app.asar.unpacked");
    expect(resolved).toContain("default-apps");
  });
});
