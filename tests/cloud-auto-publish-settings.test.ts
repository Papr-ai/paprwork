import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isCloudAutoPublishGloballyEnabled } from "../src/gateway/services/cloudAutoPublishSettings.js";

describe("cloudAutoPublishSettings", () => {
  const originalEnv = process.env.CLOUD_AUTO_PUBLISH_ENABLED;
  const tmpHome = path.join(os.tmpdir(), `papr-auto-publish-test-${Date.now()}`);
  const settingsPath = path.join(tmpHome, "settings.json");

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLOUD_AUTO_PUBLISH_ENABLED;
    } else {
      process.env.CLOUD_AUTO_PUBLISH_ENABLED = originalEnv;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("defaults to enabled when no settings file exists", () => {
    expect(isCloudAutoPublishGloballyEnabled(settingsPath)).toBe(true);
  });

  it("reads false when user disables auto publish in settings", () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ preferences: { cloudAutoPublishEnabled: false } }),
      "utf8",
    );
    expect(isCloudAutoPublishGloballyEnabled(settingsPath)).toBe(false);
  });

  it("respects CLOUD_AUTO_PUBLISH_ENABLED=false env override", () => {
    process.env.CLOUD_AUTO_PUBLISH_ENABLED = "false";
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ preferences: { cloudAutoPublishEnabled: true } }),
      "utf8",
    );
    expect(isCloudAutoPublishGloballyEnabled(settingsPath)).toBe(false);
  });
});
