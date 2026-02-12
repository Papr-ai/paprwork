/**
 * Settings Types - Shared type definitions for settings functionality
 */

export interface CustomKey {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask";
  createdAt: string;
  updatedAt: string;
}

export interface CustomKeyInput {
  name: string;
  value: string;
  description?: string;
  permission?: "always" | "ask";
}

export interface ProviderConfig {
  apiKey: string;
  defaultModel?: string;
  models?: string[];
}

export interface AppPreferences {
  theme: "light" | "dark" | "system";
  language: string;
  autoSave: boolean;
  keyboardShortcuts: boolean;
}

export interface UserProfile {
  name?: string;
  email?: string;
  imageUrl?: string;
}

export type PermissionLevel = "open" | "moderate" | "strict";

export type SettingsTab = "keys" | "profile" | "permissions";
