import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Mac native packaging scripts", () => {
  it("defines arm64 and x64 swap lists in prepare-mac-native-deps.mjs", () => {
    const scriptPath = path.resolve(
      __dirname,
      "../scripts/prepare-mac-native-deps.mjs",
    );
    const source = fs.readFileSync(scriptPath, "utf8");

    expect(source).toContain("@libsql/darwin-x64@0.4.7");
    expect(source).toContain("@libsql/darwin-arm64@0.4.7");
    expect(source).toContain("@tursodatabase/sync-darwin-arm64@0.7.2");
    expect(source).toMatch(/remove:[\s\S]*@tursodatabase\/sync-darwin-arm64/);
  });

  it("release workflow builds arm64 and x64 separately with native verification", () => {
    const workflowPath = path.resolve(__dirname, "../.github/workflows/release.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("prepare-mac-native-deps.mjs arm64");
    expect(workflow).toContain("prepare-mac-native-deps.mjs x64");
    expect(workflow).toContain("electron-builder --mac --arm64");
    expect(workflow).toContain("electron-builder --mac --x64");
    expect(workflow).toContain("verify-packaged-native-arch.mjs");
    expect(workflow).toContain("verify-packaged-mini-app-sdk.mjs");
    expect(workflow).not.toContain("electron-builder --mac --arm64 --x64");
  });
});
