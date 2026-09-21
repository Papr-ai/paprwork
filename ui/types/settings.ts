/**
 * Settings Types - Shared type definitions for settings functionality
 */

export type IntegrationKeyOrgScope = "organization" | "all";

export type IntegrationKeyVaultAudience =
  | "user"
  | "members"
  | "namespace"
  | "org";

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
  oauthProvider?: "openai" | "anthropic" | "google";
  scope?: "global" | "shared" | "org";
  orgScope?: IntegrationKeyOrgScope | "global";
  organizationId?: string;
  vaultAudience?: IntegrationKeyVaultAudience;
  vaultOrigin?: "local" | "shared";
  sharedShareScope?: Extract<
    IntegrationKeyVaultAudience,
    "namespace" | "org" | "members"
  >;
  sharedOwnerUserId?: string;
  sharedSyncedAt?: string;
  vaultSharedNameCollision?: boolean;
  vaultAudienceMemberIds?: string[];
  vaultShareBlocked?: boolean;
  vaultShareBlockedOwnerUserId?: string;
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
  vaultAudienceMemberIds?: string[];
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
  | "platforms"
  | "profile"
  | "billing"
  | "permissions"
  | "privacy"
  | "migration"
  | "about"
  /** Dev-only harness; the nav entry and panel exist only when import.meta.env.DEV. */
  | "dev";

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
