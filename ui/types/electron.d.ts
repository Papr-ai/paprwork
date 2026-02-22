/**
 * Electron API type definitions
 * These match the APIs exposed in src/electron/preload.ts
 */

import type { AgentConfig, CoreMessage, StreamChunk } from "./core";

export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface CustomKeyMetadata {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask";
  createdAt: string;
  updatedAt: string;
}

interface CustomKeyInput {
  name: string;
  value: string;
  description?: string;
  permission?: "always" | "ask";
}

export interface ElectronAPI {
  // Custom Keys API (secure storage via macOS Keychain)
  customKeys: {
    list: () => Promise<CustomKeyMetadata[]>;
    get: (keyId: string) => Promise<string | null>;
    getByName: (name: string) => Promise<string | null>;
    add: (input: CustomKeyInput) => Promise<CustomKeyMetadata>;
    update: (
      keyId: string,
      updates: Partial<CustomKeyInput>,
    ) => Promise<CustomKeyMetadata | null>;
    delete: (keyId: string) => Promise<boolean>;
    resolve: (text: string, allowedKeys?: string[]) => Promise<string>;
    getRequired: (text: string) => Promise<string[]>;
  };

  // Permissions API
  permissions: {
    onKeyRequest: (
      callback: (event: any, request: KeyPermissionRequest) => void,
    ) => void;
    respondToRequest: (response: {
      requestId: string;
      keyName: string;
      response: KeyPermissionResponse;
    }) => void;
    getAll: () => Promise<{
      keyPermissions: Record<string, KeyPermission>;
      settings: PermissionSettings;
    }>;
    updateSettings: (settings: Partial<PermissionSettings>) => Promise<void>;
    resetKey: (keyName: string) => Promise<void>;
    getLevel: () => Promise<PermissionLevel>;
    setLevel: (level: PermissionLevel) => Promise<void>;
  };

  // OAuth API
  oauth: {
    openai: {
      startOAuth: () => Promise<{
        success: boolean;
        url?: string;
        error?: string;
      }>;
      getStatus: () => Promise<{
        connected: boolean;
        accountId?: string;
        expiresAt?: string;
        isExpired?: boolean;
        error?: string;
      }>;
      disconnect: () => Promise<{ success: boolean; error?: string }>;
    };
    claude: {
      startOAuth: () => Promise<{
        success: boolean;
        url?: string;
        error?: string;
      }>;
      getStatus: () => Promise<{
        connected: boolean;
        accountId?: string;
        expiresAt?: string;
        isExpired?: boolean;
        error?: string;
      }>;
      disconnect: () => Promise<{ success: boolean; error?: string }>;
    };
  };

  // Legacy agent/chat APIs (not currently used - UI uses WebSocket Gateway)
  agent: {
    stream: (params: {
      sessionId: string;
      message: string;
      config: AgentConfig;
    }) => Promise<{ success: boolean }>;

    onStreamChunk: (callback: (chunk: StreamChunk) => void) => () => void;

    getHistory: (sessionId: string) => Promise<{
      success: boolean;
      messages?: CoreMessage[];
      error?: string;
    }>;

    clearHistory: (sessionId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
  };

  chat: {
    create: (title?: string) => Promise<{
      success: boolean;
      chatId?: string;
      error?: string;
    }>;

    delete: (chatId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;

    list: () => Promise<{
      success: boolean;
      chats?: ChatMetadata[];
      error?: string;
    }>;

    setActive: (chatId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;

    updateTitle: (
      chatId: string,
      title: string,
    ) => Promise<{
      success: boolean;
      error?: string;
    }>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
