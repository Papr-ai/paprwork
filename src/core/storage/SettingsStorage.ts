/**
 * Settings storage - Handles app settings persistence
 * Uses electron-store for encrypted, atomic updates
 */

import { randomUUID } from "node:crypto";
import Store from "electron-store";
import type {
  AppSettings,
  Provider,
  CompactionConfig,
} from "../types/index.js";
import type {
  PermissionSettings,
  PermissionLevel,
} from "../types/permissions.js";
import { DEFAULT_PERMISSION_SETTINGS } from "../types/permissions.js";

const DEFAULT_SETTINGS: AppSettings = {
  providers: {},
  preferences: {
    theme: "system",
    language: "en",
    autoSave: true,
    keyboardShortcuts: true,
    telemetryEnabled: false,
    defaultHomeAppId: "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c", // Weekly War Room
    cloudSyncEnabled: true,
    cloudAutoPublishEnabled: true,
    cloudAutoUploadEnabled: true,
    defaultMemoryScope: "user",
  },
  telemetry: {},
  compaction: {
    maxTokens: 100000,
    targetTokens: 50000,
    minMessagesToKeep: 10,
    compactionPrompt: "Summarize the conversation history above concisely.",
  },
  permissions: DEFAULT_PERMISSION_SETTINGS,
};

export interface SettingsStorageOptions {
  /**
   * When true (typical for installed Mac/Windows/Linux packages), new installs default
   * telemetry to on. Omit or false for dev/tests. User can still opt out in Settings.
   */
  defaultTelemetryEnabled?: boolean;
}

export class SettingsStorage {
  private store: Store<AppSettings>;
  private readonly telemetryDefaultFallback: boolean;

  constructor(storagePath?: string, options?: SettingsStorageOptions) {
    const telemetryDefault = options?.defaultTelemetryEnabled ?? false;
    this.telemetryDefaultFallback = telemetryDefault;
    const defaults: AppSettings = {
      ...DEFAULT_SETTINGS,
      preferences: {
        ...DEFAULT_SETTINGS.preferences,
        telemetryEnabled: telemetryDefault,
      },
    };
    this.store = new Store<AppSettings>({
      name: "settings",
      defaults,
      encryptionKey: "paprwork-v2-secure-settings",
      ...(storagePath ? { cwd: storagePath } : {}),
    });
  }

  /**
   * Get all settings
   */
  getAll(): AppSettings {
    return this.store.store;
  }

  /**
   * Set API key for a provider
   */
  setProviderApiKey(provider: Provider, apiKey: string): void {
    const providerConfig = this.store.get(`providers.${provider}`, {
      apiKey: "",
      models: [],
    });

    this.store.set(`providers.${provider}`, {
      ...providerConfig,
      apiKey,
    });
  }

  /**
   * Get API key for a provider
   */
  getProviderApiKey(provider: Provider): string | undefined {
    return this.store.get(`providers.${provider}.apiKey`);
  }

  /**
   * Set default model for a provider
   */
  setProviderDefaultModel(provider: Provider, model: string): void {
    const providerConfig = this.store.get(`providers.${provider}`, {
      apiKey: "",
      models: [],
    });

    this.store.set(`providers.${provider}`, {
      ...providerConfig,
      defaultModel: model,
    });
  }

  /**
   * Get default model for a provider
   */
  getProviderDefaultModel(provider: Provider): string | undefined {
    return this.store.get(`providers.${provider}.defaultModel`);
  }

  /**
   * Set theme preference
   */
  setTheme(theme: "light" | "dark" | "system"): void {
    this.store.set("preferences.theme", theme);
  }

  /**
   * Get theme preference
   */
  getTheme(): "light" | "dark" | "system" {
    return this.store.get("preferences.theme", "system");
  }

  /**
   * Set language
   */
  setLanguage(language: string): void {
    this.store.set("preferences.language", language);
  }

  /**
   * Get language
   */
  getLanguage(): string {
    return this.store.get("preferences.language", "en");
  }

  /**
   * Set auto-save preference
   */
  setAutoSave(enabled: boolean): void {
    this.store.set("preferences.autoSave", enabled);
  }

  /**
   * Get auto-save preference
   */
  getAutoSave(): boolean {
    return this.store.get("preferences.autoSave", true);
  }

  /**
   * Anonymous usage telemetry preference. Persisted in encrypted store.
   */
  getTelemetryEnabled(): boolean {
    return this.store.get(
      "preferences.telemetryEnabled",
      this.telemetryDefaultFallback,
    );
  }

  setTelemetryEnabled(enabled: boolean): void {
    this.store.set("preferences.telemetryEnabled", enabled);
  }

  /**
   * Stable random id per install for anonymous DAU-style metrics only.
   */
  getOrCreateTelemetryInstallId(): string {
    const existing = this.store.get("telemetry.installId");
    if (typeof existing === "string" && existing.length > 0) {
      return existing;
    }
    const id = randomUUID();
    this.store.set("telemetry.installId", id);
    return id;
  }

  /**
   * Set compaction config
   */
  setCompactionConfig(config: Partial<CompactionConfig>): void {
    const currentConfig = this.store.get(
      "compaction",
      DEFAULT_SETTINGS.compaction,
    );
    this.store.set("compaction", { ...currentConfig, ...config });
  }

  /**
   * Get compaction config
   */
  getCompactionConfig(): CompactionConfig {
    return this.store.get("compaction", DEFAULT_SETTINGS.compaction);
  }

  /**
   * Reset all settings to defaults
   */
  reset(): void {
    this.store.clear();
    this.store.store = DEFAULT_SETTINGS;
  }

  /**
   * Check if provider is configured
   */
  isProviderConfigured(provider: Provider): boolean {
    const apiKey = this.getProviderApiKey(provider);
    return Boolean(apiKey && apiKey.length > 0);
  }

  /**
   * Set permission level
   */
  setPermissionLevel(level: PermissionLevel): void {
    const permissions = this.store.get(
      "permissions",
      DEFAULT_PERMISSION_SETTINGS,
    );
    this.store.set("permissions", { ...permissions, permissionLevel: level });
  }

  /**
   * Get permission level
   */
  getPermissionLevel(): PermissionLevel {
    return this.store.get("permissions.permissionLevel", "open");
  }

  /**
   * Set permission settings
   */
  setPermissionSettings(settings: Partial<PermissionSettings>): void {
    const current = this.store.get("permissions", DEFAULT_PERMISSION_SETTINGS);
    this.store.set("permissions", { ...current, ...settings });
  }

  /**
   * Get permission settings
   */
  getPermissionSettings(): PermissionSettings {
    return this.store.get("permissions", DEFAULT_PERMISSION_SETTINGS);
  }

  /**
   * Get specific tool permission
   */
  getToolPermission(tool: "bash" | "fileWrite" | "browser"): boolean {
    const settings = this.getPermissionSettings();
    switch (tool) {
      case "bash":
        return settings.requireConfirmForBash;
      case "fileWrite":
        return settings.requireConfirmForFileWrite;
      case "browser":
        return settings.requireConfirmForBrowser;
      default:
        return false;
    }
  }

  /**
   * Set Papr user profile
   */
  setPaprProfile(profile: NonNullable<AppSettings["paprProfile"]>): void {
    // Merge with existing profile to preserve fields not in this update
    const existing = this.store.get("paprProfile");
    this.store.set("paprProfile", { ...existing, ...profile });
  }

  /**
   * Get Papr user profile
   */
  getPaprProfile(): AppSettings["paprProfile"] | undefined {
    return this.store.get("paprProfile");
  }

  /**
   * Clear Papr user profile
   */
  clearPaprProfile(): void {
    this.store.delete("paprProfile");
  }
}
