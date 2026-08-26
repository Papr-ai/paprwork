import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Regression: every mini-app rendered blank on packaged builds (v2.4.6).
 *
 * The SDK route bundles `dist/resources/mini-app-sdk/*.ts` with esbuild.
 * esbuild is a native binary in a child process, and the asar virtual
 * filesystem is patched into Electron's `fs` only — a child process sees
 * `app.asar` as one opaque file. So the bundle failed with:
 *
 *   Could not resolve ".../app.asar/dist/resources/mini-app-sdk/papr-job-events.ts"
 *
 * `/__papr__/papr-job-events.ts` returned 500, the app bundle never
 * evaluated, and the mini-app showed nothing — with an EMPTY console, since
 * a failed module fetch logs no error. Only the network tab revealed it.
 *
 * Two guards below: the packaging config must unpack the SDK, and the route
 * must resolve to the unpacked copy.
 */

const repoRoot = path.resolve(__dirname, "..");

describe("mini-app SDK packaging", () => {
  it("unpacks the SDK from asar so esbuild can read it", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "electron-builder.json"), "utf8"),
    ) as { asarUnpack?: string[] };

    const unpack = config.asarUnpack ?? [];

    // Without this, esbuild cannot resolve the SDK entry points and every
    // mini-app that imports from /__papr__/ renders blank.
    expect(unpack).toContain("dist/resources/mini-app-sdk/**");

    // esbuild itself must stay unpacked for the same reason.
    expect(unpack).toContain("node_modules/esbuild/**");
  });

  it("resolves SDK_DIR to app.asar.unpacked when loaded from inside an asar", () => {
    const source = fs.readFileSync(
      path.join(
        repoRoot,
        "src/gateway/utils/registerPaprMiniAppSdkRoutes.ts",
      ),
      "utf8",
    );

    // The route must redirect into the unpacked tree rather than handing
    // esbuild a path inside the archive.
    expect(source).toContain("app.asar.unpacked");

    // fs-based probing cannot pick the right path here: Electron's patched
    // fs reports the in-asar path as readable, which is the broken one.
    const chooses = /existsSync[\s\S]{0,200}mini-app-sdk/.test(source);
    expect(chooses).toBe(false);
  });

  it("keeps every SDK entry point inside the unpacked directory", () => {
    const sdkDir = path.join(repoRoot, "src/resources/mini-app-sdk");
    const entryPoints = fs
      .readdirSync(sdkDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

    // Guards against a future SDK file living outside the unpacked glob.
    expect(entryPoints.length).toBeGreaterThan(0);
    for (const file of entryPoints) {
      expect(path.join("dist/resources/mini-app-sdk", file)).toMatch(
        /^dist\/resources\/mini-app-sdk\//,
      );
    }
  });
});
