/**
 * Gateway settings file store (no WebSocket imports — safe for unit tests).
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";
import {
  DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
  mergeToolResultTruncationSettings,
  type ToolResultTruncationSettings,
} from "../../core/types/toolResultTruncationSettings.js";

export interface ProfileData {
  name: string;
  email: string;
  imageUrl: string;
  /** True when a local photo still needs to be uploaded to Papr. */
  profileImageSyncPending?: boolean;
}

export interface PermissionData {
  fileSystem: boolean;
  network: boolean;
  calendar: boolean;
}

export interface CodeIndexingSettings {
  enabled: boolean;
  excludedFolders: string[];
}

export interface UIPreferences {
  lastModelId: string | null;
  enabledPickerModelIds?: string[] | null;
  onboardingDismissed: boolean;
  onboardingStep1Completed: boolean;
  onboardingStep2Completed: boolean;
  onboardingStep3Completed: boolean;
}

export type MemoryAudiencePreference = "user" | "namespace" | "org";

export interface PreferencesData {
  defaultHomeAppId: string | null;
  cloudSyncEnabled: boolean;
  cloudAutoPublishEnabled: boolean;
  cloudAutoUploadEnabled: boolean;
  defaultMemoryScope?: MemoryAudiencePreference;
}

export interface TelemetryData {
  installId: string;
  enabled: boolean;
}

export interface SettingsData {
  profile: ProfileData;
  permissions: PermissionData;
  codeIndexing: CodeIndexingSettings;
  uiPreferences: UIPreferences;
  preferences: PreferencesData;
  toolResultTruncation: ToolResultTruncationSettings;
  telemetry?: TelemetryData;
}

const DEFAULT_HOME_APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";

export const DEFAULT_SETTINGS: SettingsData = {
  profile: { name: "", email: "", imageUrl: "" },
  permissions: { fileSystem: true, network: true, calendar: false },
  codeIndexing: {
    enabled: true,
    excludedFolders: [
      "papr_repo",
      "node_modules",
      ".venv",
      "venv",
      ".git",
      "dist",
      "build",
      "__pycache__",
      ".next",
      ".nuxt",
    ],
  },
  uiPreferences: {
    lastModelId: null,
    enabledPickerModelIds: null,
    onboardingDismissed: false,
    onboardingStep1Completed: false,
    onboardingStep2Completed: false,
    onboardingStep3Completed: false,
  },
  preferences: {
    defaultHomeAppId: DEFAULT_HOME_APP_ID,
    cloudSyncEnabled: true,
    cloudAutoPublishEnabled: false,
    cloudAutoUploadEnabled: false,
    defaultMemoryScope: "user",
  },
  toolResultTruncation: { ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS },
};

/** Resolved at call time so per-run PAPR_HOME clones (cloud agent) pick up settings.json. */
export function getSettingsPath(): string {
  const override = process.env.PAPR_TRUNCATION_SETTINGS_PATH?.trim();
  if (override) {
    return override;
  }
  return path.join(getPaprDataDir(), "settings.json");
}

async function syncToolResultTruncationCache(
  settings: ToolResultTruncationSettings,
): Promise<void> {
  const { setToolResultTruncationSettings } = await import(
    "./agent/toolResultTruncationSettings.js"
  );
  setToolResultTruncationSettings(settings);
}

function attachTelemetry(settings: SettingsData): SettingsData {
  const installId = process.env.PAPRWORK_TELEMETRY_ANONYMOUS_ID?.trim() || "";
  const enabled = process.env.PAPRWORK_TELEMETRY_ENABLED === "true";
  if (installId) {
    settings.telemetry = { installId, enabled };
  }
  return settings;
}

export async function loadSettings(): Promise<SettingsData> {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf-8");
    const saved = JSON.parse(raw) as Partial<SettingsData>;
    const settings = attachTelemetry({
      ...DEFAULT_SETTINGS,
      ...saved,
      profile: { ...DEFAULT_SETTINGS.profile, ...saved.profile },
      permissions: { ...DEFAULT_SETTINGS.permissions, ...saved.permissions },
      codeIndexing: { ...DEFAULT_SETTINGS.codeIndexing, ...saved.codeIndexing },
      uiPreferences: { ...DEFAULT_SETTINGS.uiPreferences, ...saved.uiPreferences },
      preferences: { ...DEFAULT_SETTINGS.preferences, ...saved.preferences },
      toolResultTruncation: mergeToolResultTruncationSettings(
        saved.toolResultTruncation,
      ),
    });

    await syncToolResultTruncationCache(settings.toolResultTruncation);
    return settings;
  } catch {
    const settings = attachTelemetry({ ...DEFAULT_SETTINGS });
    await syncToolResultTruncationCache(settings.toolResultTruncation);
    return settings;
  }
}

export async function saveSettings(data: SettingsData): Promise<void> {
  const settingsPath = getSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(data, null, 2), "utf-8");
}

export interface SettingsPatch {
  profile?: Partial<ProfileData>;
  permissions?: Partial<PermissionData>;
  codeIndexing?: Partial<CodeIndexingSettings>;
  uiPreferences?: Partial<UIPreferences>;
  preferences?: Partial<PreferencesData>;
  toolResultTruncation?: Partial<ToolResultTruncationSettings>;
  telemetry?: Partial<TelemetryData>;
}

function applySettingsPatch(
  current: SettingsData,
  patch: SettingsPatch,
): SettingsData {
  const next: SettingsData = { ...current };

  if (patch.profile) {
    next.profile = { ...current.profile, ...patch.profile };
  }
  if (patch.permissions) {
    next.permissions = { ...current.permissions, ...patch.permissions };
  }
  if (patch.codeIndexing) {
    next.codeIndexing = { ...current.codeIndexing, ...patch.codeIndexing };
  }
  if (patch.uiPreferences) {
    next.uiPreferences = { ...current.uiPreferences, ...patch.uiPreferences };
  }
  if (patch.preferences) {
    next.preferences = { ...current.preferences, ...patch.preferences };
  }
  if (patch.toolResultTruncation) {
    next.toolResultTruncation = mergeToolResultTruncationSettings({
      ...current.toolResultTruncation,
      ...patch.toolResultTruncation,
    });
  }
  if (patch.telemetry && current.telemetry) {
    next.telemetry = { ...current.telemetry, ...patch.telemetry };
  }

  return next;
}

let settingsWriteChain: Promise<unknown> = Promise.resolve();

/** Serialize read-modify-write so concurrent UI saves cannot clobber each other. */
export async function patchSettings(patch: SettingsPatch): Promise<SettingsData> {
  const run = settingsWriteChain.then(async () => {
    const current = await loadSettings();
    const next = applySettingsPatch(current, patch);
    await saveSettings(next);
    if (patch.toolResultTruncation) {
      await syncToolResultTruncationCache(next.toolResultTruncation);
    }
    return next;
  });
  settingsWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
