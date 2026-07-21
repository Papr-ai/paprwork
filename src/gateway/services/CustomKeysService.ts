/**
 * Custom Keys Service - Gateway bridge to Electron IPC
 *
 * Provides access to securely stored custom API keys.
 * In production, communicates with Electron main process via IPC.
 * In development, uses a local fallback (not secure, for testing only).
 */

import { randomUUID } from "node:crypto";
import type { CustomKeyInput } from "../../core/storage/CustomKeysStorage.js";
import { loadCustomKeysMetadataFromFile } from "../utils/customKeysFile.js";

interface CustomKey {
  id: string;
  name: string;
  value: string;
  description?: string;
  permission: "always" | "ask";
  clientAccess?: "server" | "client";
  createdAt: string;
  updatedAt?: string;
  source?: "manual" | "oauth";
  managedBy?: "oauth";
  oauthProvider?: "openai" | "anthropic";
}

type CustomKeyMetadata = Omit<CustomKey, "value">;

interface PendingIpcRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CustomKeysIpcMessage {
  type?: string;
  requestId?: string;
  error?: string;
  keys?: CustomKeyMetadata[];
  value?: string | null;
  key?: CustomKey;
}

/**
 * Custom Keys Service - Singleton
 */
type KeyChangeListener = (keyName?: string) => void;

export class CustomKeysService {
  private initialized = false;
  private ipcAvailable = false;
  private ipcWaitAttempts = 0;
  private readonly MAX_IPC_WAIT_ATTEMPTS = 10; // Wait up to 1 second
  private readonly IPC_WAIT_INTERVAL_MS = 100;
  private readonly IPC_TIMEOUT_MS = 15_000;
  private readonly CACHE_TTL_MS = 30_000;

  private ipcDispatcherRegistered = false;
  private readonly pendingRequests = new Map<string, PendingIpcRequest>();
  private readonly changeListeners: KeyChangeListener[] = [];

  private listKeysCache: CustomKeyMetadata[] | null = null;
  private listKeysCacheAt = 0;
  private listKeysInFlight: Promise<CustomKeyMetadata[]> | null = null;

  private readonly valueCache = new Map<string, { value: string | null; cachedAt: number }>();
  private readonly valueInFlight = new Map<string, Promise<string | null>>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    
    // Wait for IPC to be available (with timeout)
    await this.waitForIpc();
    
    this.ipcAvailable = this.checkIpcAvailable();
    console.log(
      `[CustomKeysService] Initialized (IPC: ${this.ipcAvailable ? "available" : "unavailable"})`
    );
  }

  /**
   * Wait for IPC channel to be ready (Gateway might start before IPC is established)
   */
  private async waitForIpc(): Promise<void> {
    while (this.ipcWaitAttempts < this.MAX_IPC_WAIT_ATTEMPTS) {
      if (typeof process.send === "function" && process.connected === true) {
        console.log(
          `[CustomKeysService] IPC ready after ${this.ipcWaitAttempts} attempts (${this.ipcWaitAttempts * this.IPC_WAIT_INTERVAL_MS}ms)`
        );
        return;
      }
      
      this.ipcWaitAttempts++;
      await new Promise((resolve) =>
        setTimeout(resolve, this.IPC_WAIT_INTERVAL_MS)
      );
    }
    
    console.warn(
      `[CustomKeysService] IPC not ready after ${this.MAX_IPC_WAIT_ATTEMPTS} attempts (${this.MAX_IPC_WAIT_ATTEMPTS * this.IPC_WAIT_INTERVAL_MS}ms)`
    );
  }

  /**
   * Check if IPC channel is available and connected
   */
  private checkIpcAvailable(): boolean {
    // Check if process.send exists (means we were spawned with IPC)
    const hasSend = typeof process.send === "function";
    // Check if IPC channel is connected (will be false if disconnected)
    const isConnected = process.connected === true;
    
    /*console.log(
      `[CustomKeysService] IPC availability check:`,
      `hasSend=${hasSend}, isConnected=${isConnected}, connected=${process.connected}`
    );*/
    
    if (!hasSend) {
      console.warn("[CustomKeysService] No process.send - not spawned with IPC");
      return false;
    }
    
    if (!isConnected) {
      console.warn("[CustomKeysService] process.connected is not true - IPC channel not established");
      return false;
    }
    
    return true;
  }

  /**
   * Safe IPC send - returns false if channel closed
   */
  private safeSend(message: Record<string, unknown>): boolean {
    if (!this.checkIpcAvailable()) {
      return false;
    }
    try {
      process.send!(message);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_IPC_CHANNEL_CLOSED"
      ) {
        console.warn("[CustomKeysService] IPC channel closed");
        this.ipcAvailable = false;
      } else {
        console.error("[CustomKeysService] IPC send error:", error);
      }
      return false;
    }
  }

  private ensureIpcDispatcher(): void {
    if (this.ipcDispatcherRegistered) return;
    this.ipcDispatcherRegistered = true;

    process.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const msg = message as CustomKeysIpcMessage;

      if (msg.type === "INVALIDATE_KEY_CACHE") {
        this.invalidateCache();
        return;
      }

      if (msg.type !== "CUSTOM_KEYS_RESPONSE" || !msg.requestId) return;

      const pending = this.pendingRequests.get(msg.requestId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.requestId);

      if (msg.error) {
        pending.reject(new Error(msg.error));
        return;
      }

      pending.resolve(msg);
    });
  }

  private createRequestId(prefix: string): string {
    return `${prefix}-${Date.now()}-${randomUUID()}`;
  }

  private sendIpcRequest(
    message: Record<string, unknown>,
    timeoutMessage: string,
  ): Promise<CustomKeysIpcMessage> {
    this.ensureIpcDispatcher();

    return new Promise((resolve, reject) => {
      const requestId = this.createRequestId(
        typeof message.type === "string" ? message.type : "custom-keys",
      );

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(timeoutMessage));
      }, this.IPC_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as CustomKeysIpcMessage),
        reject,
        timeout,
      });

      if (!this.safeSend({ ...message, requestId })) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new Error("IPC channel closed"));
      }
    });
  }

  /**
   * Register a callback invoked whenever keys are added, updated, or deleted.
   * Used by VaultSyncService to push changes to the cloud vault.
   */
  onKeyChange(listener: KeyChangeListener): void {
    this.changeListeners.push(listener);
  }

  invalidateCache(keyName?: string): void {
    if (keyName) {
      this.valueCache.delete(keyName);
      this.valueInFlight.delete(keyName);
    } else {
      this.listKeysCache = null;
      this.listKeysCacheAt = 0;
      this.listKeysInFlight = null;
      this.valueCache.clear();
      this.valueInFlight.clear();
    }

    for (const listener of this.changeListeners) {
      try {
        listener(keyName);
      } catch {
        /* listeners should not break cache invalidation */
      }
    }
  }

  private isListCacheFresh(): boolean {
    return (
      this.listKeysCache !== null &&
      Date.now() - this.listKeysCacheAt < this.CACHE_TTL_MS
    );
  }

  private isValueCacheFresh(name: string): boolean {
    const cached = this.valueCache.get(name);
    return cached !== undefined && Date.now() - cached.cachedAt < this.CACHE_TTL_MS;
  }

  /**
   * List all custom keys (metadata only, no values)
   */
  async listKeys(): Promise<CustomKeyMetadata[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.isListCacheFresh() && this.listKeysCache) {
      return this.listKeysCache;
    }

    if (this.listKeysInFlight) {
      return this.listKeysInFlight;
    }

    if (!this.ipcAvailable) {
      console.warn("[CustomKeysService] No IPC available - running in dev mode");
      return [];
    }

    this.listKeysInFlight = (async () => {
      try {
        const response = await this.sendIpcRequest(
          { type: "CUSTOM_KEYS_LIST" },
          "Custom keys list request timed out",
        );
        const keys = response.keys ?? [];
        this.listKeysCache = keys;
        this.listKeysCacheAt = Date.now();
        return keys;
      } catch (error) {
        if (error instanceof Error && error.message === "IPC channel closed") {
          console.warn(
            "[CustomKeysService] IPC channel closed - falling back to dev mode",
          );
          return [];
        }

        // IPC timeout: read metadata from on-disk index (no decryption needed)
        try {
          const keys = await loadCustomKeysMetadataFromFile();
          console.warn(
            `[CustomKeysService] IPC list timed out — loaded ${keys.length} key(s) from custom-keys.json`,
          );
          this.listKeysCache = keys;
          this.listKeysCacheAt = Date.now();
          return keys;
        } catch (fileError) {
          console.error(
            "[CustomKeysService] IPC list timed out and file fallback failed:",
            fileError,
          );
          throw error;
        }
      } finally {
        this.listKeysInFlight = null;
      }
    })();

    return this.listKeysInFlight;
  }

  /**
   * Get a custom key value by name
   */
  async getKeyByName(name: string): Promise<string | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.isValueCacheFresh(name)) {
      return this.valueCache.get(name)?.value ?? null;
    }

    const inFlight = this.valueInFlight.get(name);
    if (inFlight) {
      return inFlight;
    }

    if (!this.ipcAvailable) {
      console.warn(`[CustomKeysService] No IPC - checking env for ${name}`);
      return process.env[name] || null;
    }

    const request = (async () => {
      try {
        const response = await this.sendIpcRequest(
          { type: "CUSTOM_KEYS_GET_BY_NAME", name },
          "Custom key get request timed out",
        );
        const value = response.value ?? null;
        this.valueCache.set(name, { value, cachedAt: Date.now() });
        return value;
      } catch (error) {
        if (error instanceof Error && error.message === "IPC channel closed") {
          console.warn(
            `[CustomKeysService] IPC channel closed - checking env for ${name}`,
          );
          return process.env[name] || null;
        }

        // IPC timeout: reuse REQUEST_KEYS (works even when CUSTOM_KEYS_GET_BY_NAME stalls)
        try {
          const { resolveKeysViaIpc } = await import("../utils/keyResolver.js");
          const resolved = await resolveKeysViaIpc([name], process);
          const value = resolved[name] ?? null;
          if (value) {
            console.warn(
              `[CustomKeysService] IPC get timed out for "${name}" — resolved via REQUEST_KEYS`,
            );
            this.valueCache.set(name, { value, cachedAt: Date.now() });
            return value;
          }
        } catch (fallbackError) {
          console.warn(
            `[CustomKeysService] REQUEST_KEYS fallback failed for "${name}":`,
            fallbackError,
          );
        }

        const envValue = process.env[name] || null;
        if (envValue) {
          this.valueCache.set(name, { value: envValue, cachedAt: Date.now() });
          return envValue;
        }

        console.error(`[CustomKeysService] Failed to get key "${name}":`, error);
        throw error;
      } finally {
        this.valueInFlight.delete(name);
      }
    })();

    this.valueInFlight.set(name, request);
    return request;
  }

  /**
   * Add a new custom key
   */
  async addKey(input: CustomKeyInput): Promise<CustomKey> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.ipcAvailable) {
      throw new Error("Cannot add keys - IPC not available (dev mode)");
    }

    const response = await this.sendIpcRequest(
      { type: "CUSTOM_KEYS_ADD", input },
      "Custom key add request timed out",
    );

    if (!response.key) {
      throw new Error("Custom key add response missing key payload");
    }

    this.invalidateCache(input.name);
    return response.key;
  }

  /**
   * Delete a custom key by name
   */
  async deleteKey(name: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const keys = await this.listKeys();
    const key = keys.find((k) => k.name === name);
    if (!key) {
      throw new Error(`Key '${name}' not found`);
    }

    if (!this.ipcAvailable) {
      throw new Error("Cannot delete keys - IPC not available (dev mode)");
    }

    await this.sendIpcRequest(
      { type: "CUSTOM_KEYS_DELETE", keyId: key.id },
      "Custom key delete request timed out",
    );

    this.invalidateCache(name);
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
