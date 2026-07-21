#!/usr/bin/env node
/**
 * Verify tool truncation settings: file persistence + runtime cache wiring.
 *
 * Usage: node --import tsx scripts/verify-tool-truncation-settings.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function main() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "papr-trunc-settings-"));
  const settingsPath = path.join(tempDir, "settings.json");

  process.env.PAPR_TRUNCATION_SETTINGS_PATH = settingsPath;

  const { getSettingsPath, loadSettings, saveSettings, DEFAULT_SETTINGS } =
    await import("../src/gateway/services/settingsStore.ts");

  if (getSettingsPath() !== settingsPath) {
    throw new Error(
      `Expected settings path override, got ${getSettingsPath()} vs ${settingsPath}`,
    );
  }

  const custom = {
    ...DEFAULT_SETTINGS,
    toolResultTruncation: {
      ...DEFAULT_SETTINGS.toolResultTruncation,
      disableAllTruncation: true,
      aggressiveMaxChars: 7777,
    },
  };

  await saveSettings(custom);
  const raw = JSON.parse(await readFile(settingsPath, "utf8"));
  if (raw.toolResultTruncation?.disableAllTruncation !== true) {
    throw new Error("settings.json missing disableAllTruncation");
  }
  if (raw.toolResultTruncation?.aggressiveMaxChars !== 7777) {
    throw new Error("settings.json missing custom aggressiveMaxChars");
  }

  const loaded = await loadSettings();
  if (!loaded.toolResultTruncation.disableAllTruncation) {
    throw new Error("loadSettings did not restore disableAllTruncation");
  }

  const { getToolResultTruncationSettings } = await import(
    "../src/gateway/services/agent/toolResultTruncationSettings.ts"
  );
  const cached = getToolResultTruncationSettings();
  if (!cached.disableAllTruncation || cached.aggressiveMaxChars !== 7777) {
    throw new Error(
      `Runtime cache not synced: ${JSON.stringify(cached)}`,
    );
  }

  const { truncateHistoryToolResult } = await import(
    "../src/gateway/services/agent/toolResultTruncation.ts"
  );
  const payload = "z".repeat(12_000);
  const out = truncateHistoryToolResult({
    toolName: "bash",
    toolCallId: "verify-1",
    args: {},
    resultStr: payload,
    history: [],
    messageIndex: 0,
    isOrphan: false,
  });
  if (out !== payload) {
    throw new Error(
      `Expected full bash result with disableAllTruncation, got length ${out.length}`,
    );
  }

  await rm(tempDir, { recursive: true, force: true });
  delete process.env.PAPR_TRUNCATION_SETTINGS_PATH;

  console.log("✅ Tool truncation settings: persistence + cache + disable-all OK");
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
