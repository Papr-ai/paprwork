import path from "path";
import { describe, expect, test } from "vitest";

describe("mini-app SDK bundle", () => {
  test("papr-job-events bundles as ESM with subscribeJobEvents export", async () => {
    const esbuild = await import("esbuild");
    const entry = path.join(
      process.cwd(),
      "src/resources/mini-app-sdk/papr-job-events.ts",
    );
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2020",
      write: false,
    });
    const code = result.outputFiles?.[0]?.text ?? "";
    expect(code).toContain("export");
    expect(code).toContain("subscribeJobEvents");
    expect(code).not.toMatch(/^\s*\(\s*\(\s*\)\s*=>\s*\{/);
  });
});
