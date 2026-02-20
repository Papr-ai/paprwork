/**
 * Custom Keys Service - Gateway bridge to Electron IPC
 *
 * Provides access to securely stored custom API keys.
 * In production, communicates with Electron main process via IPC.
 * In development, uses a local fallback (not secure, for testing only).
 */

import type { CustomKeyInput } from "../../core/storage/CustomKeysStorage.js";

interface CustomKey {
  id: string;
  name: string;
  value: string;
  description?: string;
  permission: "always" | "ask";
  createdAt: string;
  updatedAt?: string;
}

/**
 * Custom Keys Service - Singleton
 */
export class CustomKeysService {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    console.log("[CustomKeysService] Initialized");
  }

  /**
   * List all custom keys (metadata only, no values)
   */
  async listKeys(): Promise<Omit<CustomKey, "value">[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Gateway → Electron IPC
    if (process.send) {
      return new Promise((resolve, reject) => {
        const requestId = `custom-keys-list-${Date.now()}`;
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Custom keys list request timed out"));
        }, 5000);

        const messageHandler = (message: any) => {
          if (
            message.type === "CUSTOM_KEYS_RESPONSE" &&
            message.requestId === requestId
          ) {
            cleanup();
            if (message.error) {
              reject(new Error(message.error));
            } else {
              resolve(message.keys || []);
            }
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          process.off("message", messageHandler);
        };

        process.on("message", messageHandler);
        process.send!({
          type: "CUSTOM_KEYS_LIST",
          requestId,
        });
      });
    }

    // Dev fallback: no keys available
    console.warn("[CustomKeysService] No IPC available - running in dev mode");
    return [];
  }

  /**
   * Get a custom key value by name
   */
  async getKeyByName(name: string): Promise<string | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Gateway → Electron IPC
    if (process.send) {
      return new Promise((resolve, reject) => {
        const requestId = `custom-keys-get-${Date.now()}`;
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Custom key get request timed out"));
        }, 5000);

        const messageHandler = (message: any) => {
          if (
            message.type === "CUSTOM_KEYS_RESPONSE" &&
            message.requestId === requestId
          ) {
            cleanup();
            if (message.error) {
              reject(new Error(message.error));
            } else {
              resolve(message.value || null);
            }
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          process.off("message", messageHandler);
        };

        process.on("message", messageHandler);
        process.send!({
          type: "CUSTOM_KEYS_GET_BY_NAME",
          requestId,
          name,
        });
      });
    }

    // Dev fallback: check process.env
    console.warn(`[CustomKeysService] No IPC - checking env for ${name}`);
    return process.env[name] || null;
  }

  /**
   * Add a new custom key
   */
  async addKey(input: CustomKeyInput): Promise<CustomKey> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Gateway → Electron IPC
    if (process.send) {
      return new Promise((resolve, reject) => {
        const requestId = `custom-keys-add-${Date.now()}`;
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Custom key add request timed out"));
        }, 5000);

        const messageHandler = (message: any) => {
          if (
            message.type === "CUSTOM_KEYS_RESPONSE" &&
            message.requestId === requestId
          ) {
            cleanup();
            if (message.error) {
              reject(new Error(message.error));
            } else {
              resolve(message.key);
            }
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          process.off("message", messageHandler);
        };

        process.on("message", messageHandler);
        process.send!({
          type: "CUSTOM_KEYS_ADD",
          requestId,
          input,
        });
      });
    }

    throw new Error("Cannot add keys - IPC not available (dev mode)");
  }

  /**
   * Delete a custom key by name
   */
  async deleteKey(name: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Find key ID by name first
    const keys = await this.listKeys();
    const key = keys.find((k) => k.name === name);
    if (!key) {
      throw new Error(`Key '${name}' not found`);
    }

    // Gateway → Electron IPC
    if (process.send) {
      return new Promise((resolve, reject) => {
        const requestId = `custom-keys-delete-${Date.now()}`;
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Custom key delete request timed out"));
        }, 5000);

        const messageHandler = (message: any) => {
          if (
            message.type === "CUSTOM_KEYS_RESPONSE" &&
            message.requestId === requestId
          ) {
            cleanup();
            if (message.error) {
              reject(new Error(message.error));
            } else {
              resolve();
            }
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          process.off("message", messageHandler);
        };

        process.on("message", messageHandler);
        process.send!({
          type: "CUSTOM_KEYS_DELETE",
          requestId,
          keyId: key.id,
        });
      });
    }

    throw new Error("Cannot delete keys - IPC not available (dev mode)");
  }
}

// Singleton instance
let customKeysServiceInstance: CustomKeysService | null = null;

/**
 * Get or create CustomKeysService singleton
 */
export function getCustomKeysService(): CustomKeysService {
  if (!customKeysServiceInstance) {
    customKeysServiceInstance = new CustomKeysService();
  }
  return customKeysServiceInstance;
}
