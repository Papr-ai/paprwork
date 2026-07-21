import type { ToolResultTruncationSettings } from "../../../core/types/toolResultTruncationSettings.js";
import {
  DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
  mergeToolResultTruncationSettings,
} from "../../../core/types/toolResultTruncationSettings.js";
import { loadSettings } from "../settingsStore.js";

let cachedSettings: ToolResultTruncationSettings = {
  ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
};

export function getToolResultTruncationSettings(): ToolResultTruncationSettings {
  return cachedSettings;
}

export function setToolResultTruncationSettings(
  next: ToolResultTruncationSettings,
): ToolResultTruncationSettings {
  cachedSettings = { ...next };
  return cachedSettings;
}

export async function refreshToolResultTruncationSettings(): Promise<ToolResultTruncationSettings> {
  const settings = await loadSettings();
  cachedSettings = mergeToolResultTruncationSettings(
    settings.toolResultTruncation,
  );
  return cachedSettings;
}

export function isToolResultTruncationDisabled(): boolean {
  return cachedSettings.disableAllTruncation;
}
