/**
 * Storage and persistence types
 */

import type {
  CoreMessage,
  PersistedMessage,
  CompactionEntry,
} from "./messages";
import type { PermissionSettings } from "./permissions";

/**
 * Storage entry (message or compaction)
 */
export type StorageEntry = PersistedMessage | CompactionEntry;

/**
 * Storage manager interface
 */
export interface IStorageManager {
  saveMessage(chatId: string, message: CoreMessage): Promise<void>;
  loadMessages(chatId: string): Promise<PersistedMessage[]>;
  deleteChat(chatId: string): Promise<void>;
  listChats(): Promise<string[]>;
}

/**
 * Compaction configuration
 */
export interface CompactionConfig {
  maxTokens: number;
  targetTokens: number;
  minMessagesToKeep: number;
  compactionPrompt: string;
}

/**
 * Settings storage types
 */
export interface AppSettings {
  providers: {
    anthropic?: {
      apiKey: string;
      defaultModel: string;
    };
    openai?: {
      apiKey: string;
      defaultModel: string;
    };
    google?: {
      apiKey: string;
      defaultModel: string;
    };
  };
  preferences: {
    theme: "light" | "dark" | "system";
    language: string;
    autoSave: boolean;
    keyboardShortcuts: boolean;
    /**
     * Anonymous usage telemetry (main process → Papr proxy → Amplitude).
     * Default depends on build: on for packaged app installs, off for dev/tests unless overridden in storage.
     */
    telemetryEnabled: boolean;
    /**
     * Default app ID to open when home button is clicked.
     * If not set, shows placeholder "Agent Lounge (Coming Soon)".
     */
    defaultHomeAppId?: string;
    /**
     * Cloud sync: bidirectional git sync of ~/Papr to GitHub.
     * Enabled by default. Users can disable in Settings → General.
     */
    cloudSyncEnabled: boolean;
    /**
     * When cloud sync is on, automatically publish synced mini-apps to apps.papr.ai.
     * Enabled by default. Users can disable in Settings → Cloud Sync.
     */
    cloudAutoPublishEnabled: boolean;
    /**
     * When cloud sync is on, automatically push git/Turso changes to the cloud.
     * Enabled by default. When false, only Upload now / agent push_cloud_sync upload.
     */
    cloudAutoUploadEnabled: boolean;
    /**
     * Default Papr Memory sharing for new chats and agent writes.
     * "user" = private, "namespace" = workspace team, "org" = organization.
     */
    defaultMemoryScope?: "user" | "namespace" | "org";
    /**
     * Which credential to use when a provider has both OAuth and an API key.
     * Key resolution prefers OAuth by default, so this is the only way to reach
     * a Platform API key (and its separate rate limits) without disconnecting
     * the subscription. Unset means OAuth, matching the historical default.
     */
    providerAuthPreference?: Partial<
      Record<"openai" | "anthropic", "oauth" | "apiKey">
    >;
  };
  /** Anonymous install id for telemetry correlation only; not derived from user data. */
  telemetry: {
    installId?: string;
  };
  /** Papr user profile (fetched from dashboard after authentication) */
  paprProfile?: {
    userId: string;
    email: string;
    displayName?: string;
    profileImage?: string;
    authenticatedAt: string;
    /** Parse session token for server-side queries (namespace listing, etc.) */
    sessionToken?: string;
    /** Organization ID */
    organizationId?: string;
    /** Currently active namespace */
    activeNamespaceId?: string;
    activeNamespaceName?: string;
    /** Papr workspace tied to the active namespace (for team access on cloud apps) */
    workspaceId?: string;
    workspaceName?: string;
    /** Last known billing plan label (sidebar + settings; refreshed via getPlanSummary) */
    planName?: string;
    /** Stripe/Parse subscription lifecycle status (same source as Settings → Plan & usage) */
    subscriptionStatus?: string;
  };
  compaction: CompactionConfig;
  permissions: PermissionSettings;
}
