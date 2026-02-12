/**
 * IPC Handlers for Custom Keys
 * Bridges between UI/Gateway and secure Electron storage
 */

import * as electron from "electron";
const { ipcMain } = electron;
import { CustomKeysStorage } from "../../core/storage/CustomKeysStorage.js";
import type { CustomKeyInput } from "../../core/storage/CustomKeysStorage.js";

let customKeysStorage: CustomKeysStorage;

export function initializeCustomKeysIPC(storage: CustomKeysStorage) {
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
      return await customKeysStorage.addKey(input);
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
        return await customKeysStorage.updateKey(keyId, updates);
      } catch (error) {
        console.error("[IPC] custom-keys:update error:", error);
        throw error;
      }
    },
  );

  // Delete custom key
  ipcMain.handle("custom-keys:delete", async (_, keyId: string) => {
    try {
      return await customKeysStorage.deleteKey(keyId);
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
