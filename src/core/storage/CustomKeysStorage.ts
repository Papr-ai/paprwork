/**
 * CustomKeysStorage - Secure storage for custom API keys
 * Uses Electron safeStorage (macOS Keychain / Windows DPAPI)
 */

import fs from "fs/promises";
import path from "path";
import electron from "electron";
const { app, safeStorage } = electron;

export interface CustomKey {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask"; // Always allow or ask each time
  encryptedValue: string; // Base64 encoded encrypted value
  createdAt: string;
  updatedAt: string;
  source?: "manual" | "oauth"; // Source of the key (manual or OAuth-managed)
  managedBy?: "oauth"; // If OAuth-managed, indicates auto-refresh
  oauthProvider?: "openai" | "anthropic"; // OAuth provider if applicable
}

export interface CustomKeyInput {
  name: string;
  value: string;
  description?: string;
  permission?: "always" | "ask";
}

export class CustomKeysStorage {
  private dataDir: string;
  private keysFile: string;
  private keys: Map<string, CustomKey> = new Map();

  constructor() {
    this.dataDir = path.join(app.getPath("userData"), "data");
    this.keysFile = path.join(this.dataDir, "custom-keys.json");
  }

  /**
   * Initialize storage - create directory and load keys
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadKeys();
  }

  /**
   * Encrypt a value using Electron's safeStorage (macOS Keychain)
   */
  private encryptValue(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        "[CustomKeys] Encryption not available, using base64 encoding",
      );
      return Buffer.from(value).toString("base64");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  /**
   * Decrypt a value using Electron's safeStorage
   */
  private decryptValue(encryptedValue: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encryptedValue, "base64").toString("utf-8");
    }
    const buffer = Buffer.from(encryptedValue, "base64");
    return safeStorage.decryptString(buffer);
  }

  /**
   * Load keys from file
   */
  private async loadKeys(): Promise<void> {
    try {
      const exists = await fs
        .access(this.keysFile)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        const fileContent = await fs.readFile(this.keysFile, "utf-8");
        const data = JSON.parse(fileContent);
        this.keys = new Map(Object.entries(data));
        //console.log(`[CustomKeys] Loaded ${this.keys.size} custom keys from storage`,);
      }
    } catch (error) {
      console.error("[CustomKeys] Failed to load keys:", error);
      this.keys = new Map();
    }
  }

  /**
   * Save keys to file (atomic write)
   */
  private async saveKeys(): Promise<void> {
    try {
      const data = Object.fromEntries(this.keys);
      const tempFile = `${this.keysFile}.tmp`;

      // Write to temp file first
      await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");

      // Atomic rename
      await fs.rename(tempFile, this.keysFile);
    } catch (error) {
      console.error("[CustomKeys] Failed to save keys:", error);
      throw error;
    }
  }

  /**
   * List all custom keys (metadata only, no values)
   */
  async listKeys(): Promise<Omit<CustomKey, "encryptedValue">[]> {
    return Array.from(this.keys.values()).map((key) => ({
      id: key.id,
      name: key.name,
      description: key.description,
      permission: key.permission,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      source: key.source,
      managedBy: key.managedBy,
      oauthProvider: key.oauthProvider,
    }));
  }

  /**
   * Get a custom key by ID (decrypted value)
   */
  async getKey(keyId: string): Promise<string | null> {
    const key = this.keys.get(keyId);
    if (!key) return null;

    try {
      return this.decryptValue(key.encryptedValue);
    } catch (error) {
      console.error(`[CustomKeys] Failed to decrypt key ${keyId}:`, error);
      return null;
    }
  }

  /**
   * Get a custom key by name (decrypted value)
   */
  async getKeyByName(name: string): Promise<string | null> {
    const normalizeKeyName = (input: string): string =>
      input.trim().toUpperCase();
    const expectedName = normalizeKeyName(name);
    const key = Array.from(this.keys.values()).find(
      (k) => normalizeKeyName(k.name) === expectedName,
    );
    if (!key) return null;

    try {
      return this.decryptValue(key.encryptedValue);
    } catch (error) {
      console.error(`[CustomKeys] Failed to decrypt key ${name}:`, error);
      return null;
    }
  }

  /**
   * Get custom key metadata by name (without decrypting value)
   */
  async getKeyMetadataByName(
    name: string,
  ): Promise<Omit<CustomKey, "encryptedValue"> | null> {
    const normalizeKeyName = (input: string): string =>
      input.trim().toUpperCase();
    const expectedName = normalizeKeyName(name);
    const key = Array.from(this.keys.values()).find(
      (k) => normalizeKeyName(k.name) === expectedName,
    );
    if (!key) return null;

    return {
      id: key.id,
      name: key.name,
      description: key.description,
      permission: key.permission,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      source: key.source,
      managedBy: key.managedBy,
      oauthProvider: key.oauthProvider,
    };
  }

  /**
   * Add or update a custom key (upserts by name).
   * If a key with the same name already exists, its value and metadata are updated
   * instead of creating a duplicate entry.
   */
  async addKey(input: CustomKeyInput): Promise<CustomKey> {
    const now = new Date().toISOString();
    const normalizeKeyName = (n: string): string => n.trim().toUpperCase();
    const expectedName = normalizeKeyName(input.name);

    // Check for existing key with the same name (upsert)
    const existing = Array.from(this.keys.entries()).find(
      ([, k]) => normalizeKeyName(k.name) === expectedName,
    );

    if (existing) {
      const [existingId, existingKey] = existing;
      const updatedKey: CustomKey = {
        ...existingKey,
        encryptedValue: this.encryptValue(input.value),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.permission && { permission: input.permission }),
        updatedAt: now,
      };
      this.keys.set(existingId, updatedKey);
      await this.saveKeys();
      console.log(
        `[CustomKeys] Updated existing key: ${input.name} (id: ${existingId})`,
      );
      return updatedKey;
    }

    const id = `key-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key: CustomKey = {
      id,
      name: input.name,
      description: input.description,
      permission: input.permission || "always",
      encryptedValue: this.encryptValue(input.value),
      createdAt: now,
      updatedAt: now,
    };

    this.keys.set(id, key);
    await this.saveKeys();

    console.log(
      `[CustomKeys] Added key: ${input.name} (permission: ${key.permission})`,
    );
    return key;
  }

  /**
   * Update an existing custom key
   */
  async updateKey(
    keyId: string,
    updates: Partial<CustomKeyInput>,
  ): Promise<CustomKey | null> {
    const key = this.keys.get(keyId);
    if (!key) return null;

    const updatedKey: CustomKey = {
      ...key,
      ...(updates.name && { name: updates.name }),
      ...(updates.description !== undefined && {
        description: updates.description,
      }),
      ...(updates.permission && { permission: updates.permission }),
      ...(updates.value && {
        encryptedValue: this.encryptValue(updates.value),
      }),
      updatedAt: new Date().toISOString(),
    };

    this.keys.set(keyId, updatedKey);
    await this.saveKeys();

    console.log(`[CustomKeys] Updated key: ${keyId}`);
    return updatedKey;
  }

  /**
   * Delete a custom key
   */
  async deleteKey(keyId: string): Promise<boolean> {
    const existed = this.keys.delete(keyId);
    if (existed) {
      await this.saveKeys();
      console.log(`[CustomKeys] Deleted key: ${keyId}`);
    }
    return existed;
  }

  /**
   * Resolve placeholders like ${KEY_NAME} in text
   * Only resolves keys with 'always' permission
   */
  async resolvePlaceholders(
    text: string,
    allowedKeys?: string[],
  ): Promise<string> {
    let resolved = text;

    for (const key of this.keys.values()) {
      // Only auto-resolve keys with 'always' permission
      // or if specifically in allowedKeys list
      const shouldResolve =
        key.permission === "always" ||
        (allowedKeys && allowedKeys.includes(key.name));

      if (!shouldResolve) continue;

      const placeholder = `\${${key.name}}`;
      if (resolved.includes(placeholder)) {
        const value = await this.getKey(key.id);
        if (value) {
          resolved = resolved.replace(
            new RegExp(`\\$\\{${key.name}\\}`, "g"),
            value,
          );
        }
      }
    }

    return resolved;
  }

  /**
   * Get all key names that appear in text as ${KEY_NAME}
   */
  getRequiredKeys(text: string): string[] {
    const pattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
    const matches = text.matchAll(pattern);
    return Array.from(new Set(Array.from(matches, (m) => m[1])));
  }

  /**
   * Sanitize text by replacing actual key values with redacted placeholders
   */
  sanitizeText(text: string, resolvedKeys: Record<string, string>): string {
    let sanitized = text;

    // Replace actual values with ***KEY_NAME_REDACTED***
    for (const [keyName, value] of Object.entries(resolvedKeys)) {
      if (value && value.length > 10) {
        const valueRegex = new RegExp(
          value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "g",
        );
        sanitized = sanitized.replace(valueRegex, `***${keyName}_REDACTED***`);
      }
    }

    // Also redact common API key patterns
    sanitized = sanitized.replace(
      /\b(sk-[A-Za-z0-9]{20,})\b/g,
      "***API_KEY_REDACTED***",
    );
    sanitized = sanitized.replace(
      /\b(Bearer\s+[A-Za-z0-9_-]{20,})\b/g,
      "***BEARER_TOKEN_REDACTED***",
    );

    return sanitized;
  }
}
