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
  };
  compaction: CompactionConfig;
  permissions: PermissionSettings;
}
