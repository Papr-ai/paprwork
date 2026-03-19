/**
 * IPC Handlers for Custom Keys
 * Bridges between UI/Gateway and secure Electron storage
 */

import * as electron from "electron";
const { ipcMain } = electron;
import { CustomKeysStorage } from "../../core/storage/CustomKeysStorage.js";
import type { CustomKeyInput } from "../../core/storage/CustomKeysStorage.js";
import type { ChildProcess } from "child_process";

let customKeysStorage: CustomKeysStorage;
let gatewayProcess: ChildProcess | null = null;

/**
 * Set the Gateway process reference for cache invalidation
 */
export function setGatewayProcess(gateway: ChildProcess): void {
  gatewayProcess = gateway;
  console.log("[IPC] Gateway process reference set for cache invalidation");
}

/**
 * Send cache invalidation message to Gateway
 */
export function invalidateKeyCache(keyName?: string): void {
  if (gatewayProcess?.send) {
    console.log(
      `[IPC] Invalidating key cache: ${keyName || "all keys"}`,
    );
    gatewayProcess.send({
      type: "INVALIDATE_KEY_CACHE",
      keyName,
    });
  }
}

export function initializeCustomKeysIPC(
  storage: CustomKeysStorage,
) {
  customKeysStorage = storage;

  // List all custom keys (metadata only, no values)
  ipcMain.handle("custom-keys:list", async () => {
    try {
      return await customKeysStorage.listKeys();
    } catch (error) {
      console.error("[IPC] custom-keys:list error:", error);
      throw error;
    }
  });

  // Get key value by ID (decrypted)
  ipcMain.handle("custom-keys:get", async (_, keyId: string) => {
    try {
      return await customKeysStorage.getKey(keyId);
    } catch (error) {
      console.error("[IPC] custom-keys:get error:", error);
      throw error;
    }
  });

  // Get key value by name (decrypted)
  ipcMain.handle("custom-keys:get-by-name", async (_, name: string) => {
    try {
      return await customKeysStorage.getKeyByName(name);
    } catch (error) {
      console.error("[IPC] custom-keys:get-by-name error:", error);
      throw error;
    }
  });

  // Add new custom key
  ipcMain.handle("custom-keys:add", async (_, input: CustomKeyInput) => {
    try {
      const result = await customKeysStorage.addKey(input);
      // Invalidate cache for this key
      invalidateKeyCache(input.name);
      return result;
    } catch (error) {
      console.error("[IPC] custom-keys:add error:", error);
      throw error;
    }
  });

  // Update existing custom key
  ipcMain.handle(
    "custom-keys:update",
    async (_, keyId: string, updates: Partial<CustomKeyInput>) => {
      try {
        // Get key name before updating (for cache invalidation)
        const keys = await customKeysStorage.listKeys();
        const existingKey = keys.find((k) => k.id === keyId);
        const keyName = updates.name || existingKey?.name;

        const result = await customKeysStorage.updateKey(keyId, updates);

        // Invalidate cache for this key
        if (keyName) {
          invalidateKeyCache(keyName);
        }
        return result;
      } catch (error) {
        console.error("[IPC] custom-keys:update error:", error);
        throw error;
      }
    },
  );

  // Delete custom key
  ipcMain.handle("custom-keys:delete", async (_, keyId: string) => {
    try {
      // Get key name before deleting (for cache invalidation)
      const keys = await customKeysStorage.listKeys();
      const existingKey = keys.find((k) => k.id === keyId);

      const result = await customKeysStorage.deleteKey(keyId);

      // Invalidate cache for this key
      if (existingKey) {
        invalidateKeyCache(existingKey.name);
      }
      return result;
    } catch (error) {
      console.error("[IPC] custom-keys:delete error:", error);
      throw error;
    }
  });

  // Resolve placeholders like ${KEY_NAME} in text
  ipcMain.handle(
    "custom-keys:resolve",
    async (_, text: string, allowedKeys?: string[]) => {
      try {
        return await customKeysStorage.resolvePlaceholders(text, allowedKeys);
      } catch (error) {
        console.error("[IPC] custom-keys:resolve error:", error);
        throw error;
      }
    },
  );

  // Get required key names from text
  ipcMain.handle("custom-keys:get-required", async (_, text: string) => {
    try {
      return customKeysStorage.getRequiredKeys(text);
    } catch (error) {
      console.error("[IPC] custom-keys:get-required error:", error);
      throw error;
    }
  });

  console.log("[IPC] Custom Keys handlers registered");
}
