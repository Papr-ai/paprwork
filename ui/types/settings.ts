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
  source?: "manual" | "oauth";
  managedBy?: "oauth";
  oauthProvider?: "openai" | "anthropic";
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

export type SettingsTab = "keys" | "profile" | "permissions" | "memory";

export interface CodeIndexingStatus {
  enabled: boolean;
  schema_id: string | null;
  status: {
    is_indexing: boolean;
    stats: {
      total_files: number;
      total_projects: number;
      queue_size: number;
      last_indexed_at?: string;
    };
  } | null;
  chat_stats?: {
    total_chats: number;
    total_messages: number;
    last_indexed: string | null;
  };
}
