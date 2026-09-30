import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

describe("settingsStore patchSettings", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-settings-patch-"));
    process.env.PAPR_TRUNCATION_SETTINGS_PATH = path.join(
      tmpDir,
      "settings.json",
    );
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.PAPR_TRUNCATION_SETTINGS_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  test("concurrent ui preference patches merge without clobbering", async () => {
    const { patchSettings } = await import(
      "../src/gateway/services/settingsStore.js"
    );

    await Promise.all([
      patchSettings({
        uiPreferences: {
          enabledPickerModelIds: ["claude-sonnet-5", "claude-fable-5-1"],
        },
      }),
      patchSettings({
        uiPreferences: {
          lastModelId: "claude-sonnet-5",
        },
      }),
    ]);

    const { loadSettings } = await import(
      "../src/gateway/services/settingsStore.js"
    );
    const settings = await loadSettings();

    expect(settings.uiPreferences.enabledPickerModelIds).toEqual([
      "claude-sonnet-5",
      "claude-fable-5-1",
    ]);
    expect(settings.uiPreferences.lastModelId).toBe("claude-sonnet-5");
  });
});
