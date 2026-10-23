import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Regression: LinkedIn / platform Python jobs fail in packaged builds with
 * ModuleNotFoundError for papr_platform_browser.
 *
 * Python subprocesses cannot read paths inside app.asar. job-sdk must be
 * unpacked and PYTHONPATH must point at app.asar.unpacked, not the archive.
 */

const repoRoot = path.resolve(__dirname, "..");

describe("job SDK packaging", () => {
  it("unpacks job-sdk from asar so Python subprocesses can import it", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "electron-builder.json"), "utf8"),
    ) as { asarUnpack?: string[] };

    const unpack = config.asarUnpack ?? [];

    expect(unpack).toContain("dist/resources/job-sdk/**");
    expect(unpack).toContain("src/resources/job-sdk/**");
  });

  it("prefers app.asar.unpacked for PYTHONPATH when loaded from inside an asar", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/gateway/services/jobs/jobSdkEnv.ts"),
      "utf8",
    );

    expect(source).toContain("app.asar.unpacked");
    expect(source).toContain("papr_platform_browser.py");

    const preferFn =
      source.match(/function preferUnpackedAsarPath[\s\S]*?^}/m)?.[0] ?? "";
    expect(preferFn).not.toMatch(/existsSync/);
  });

  it("ships papr_platform_browser in dist/resources/job-sdk after build:gateway", () => {
    const sdkDir = path.join(repoRoot, "dist/resources/job-sdk");
    expect(
      fs.existsSync(path.join(sdkDir, "papr_platform_browser.py")),
      "missing dist/resources/job-sdk/papr_platform_browser.py — run npm run build:gateway",
    ).toBe(true);
  });
});
