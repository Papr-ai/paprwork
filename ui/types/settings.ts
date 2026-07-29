/**
 * Settings Types - Shared type definitions for settings functionality
 */

export type IntegrationKeyOrgScope = "organization" | "all";

export type IntegrationKeyVaultAudience = "user" | "namespace" | "org";

export interface CustomKey {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask";
  clientAccess?: "server" | "client";
  createdAt: string;
  updatedAt: string;
  source?: "manual" | "oauth";
  managedBy?: "oauth";
  oauthProvider?: "openai" | "anthropic";
  scope?: "global" | "shared" | "org";
  orgScope?: IntegrationKeyOrgScope | "global";
  organizationId?: string;
  vaultAudience?: IntegrationKeyVaultAudience;
}

export interface CustomKeyInput {
  name: string;
  value: string;
  description?: string;
  permission?: "always" | "ask";
  clientAccess?: "server" | "client";
  orgScope?: IntegrationKeyOrgScope;
  organizationId?: string;
  vaultAudience?: IntegrationKeyVaultAudience;
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

export type SettingsTab =
  | "models"
  | "keys"
  | "cloud"
  | "databases"
  | "profile"
  | "permissions"
  | "privacy"
  | "about";

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
