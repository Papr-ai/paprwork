import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PAPR_APP_CLOUD_REVISION_PATH,
  distBundleRevisionHash,
  parseAppCloudRevisionContent,
  writeAppCloudRevisionMarker,
} from "../src/gateway/services/cloudSync/cloudAppRevisionMarker.js";

describe("cloudAppRevisionMarker", () => {
  let appDir = "";

  afterEach(() => {
    if (appDir) {
      rmSync(appDir, { recursive: true, force: true });
      appDir = "";
    }
  });

  it("writes dist bundle hash as revision", () => {
    appDir = mkdtempSync(join(tmpdir(), "papr-app-rev-"));
    mkdirSync(join(appDir, "dist"), { recursive: true });
    writeFileSync(join(appDir, "dist", "app.js"), "console.log('a');", "utf8");

    writeAppCloudRevisionMarker(appDir);

    const marker = readFileSync(
      join(appDir, PAPR_APP_CLOUD_REVISION_PATH),
      "utf8",
    );
    expect(parseAppCloudRevisionContent(marker)).toBe(
      distBundleRevisionHash("console.log('a');"),
    );
  });

  it("parseAppCloudRevisionContent normalizes to lowercase", () => {
    expect(parseAppCloudRevisionContent("ABC123\n")).toBe("abc123");
    expect(parseAppCloudRevisionContent("")).toBe("0");
  });
});
