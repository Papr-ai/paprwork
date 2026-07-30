/**
 * CustomKeysStorage - Secure storage for custom API keys
 * Uses Electron safeStorage (macOS Keychain / Windows DPAPI)
 *
 * Integration keys default to the shared vault (all organizations). Session/auth tokens stay global.
 */

import fs from "fs/promises";
import path from "path";
import type { KeyClientAccess } from "../types/customKeys.js";
import { DEFAULT_KEY_CLIENT_ACCESS, normalizeKeyClientAccess } from "../types/customKeys.js";
import {
  isGlobalCustomKeyName,
  isPaprPlatformApiKeyName,
} from "./customKeysScope.js";
import { isInternalPaprNamespaceApiKeyName } from "../utils/paprApiKey.js";
import {
  LOCAL_ORG_ID,
  SHARED_ORG_ID,
  normalizeIntegrationKeyVaultAudience,
  resolveIntegrationKeyOrganizationId,
  type IntegrationKeyOrgScope,
  type IntegrationKeyVaultAudience,
} from "./customKeysVault.js";
import {
  dedupeCustomKeysByName,
  pickNewestCustomKeyByName,
  pickNewestCustomKeyEntryByName,
} from "./customKeysDedupe.js";
import electron from "electron";
const { app, safeStorage } = electron;

export interface CustomKey {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask";
  clientAccess: KeyClientAccess;
  encryptedValue: string;
  createdAt: string;
  updatedAt: string;
  source?: "manual" | "oauth";
  managedBy?: "oauth";
  oauthProvider?: "openai" | "anthropic";
  vaultAudience?: IntegrationKeyVaultAudience;
}

export interface CustomKeyInput {
  name: string;
  value: string;
  description?: string;
  permission?: "always" | "ask";
  clientAccess?: KeyClientAccess;
  /** Default: all organizations (shared vault). Use "organization" for one org only. */
  orgScope?: IntegrationKeyOrgScope;
  /** Parse org id when orgScope is organization (defaults to active org). */
  organizationId?: string;
  /** Who can use this key in cloud vault: user, team (namespace), or organization. */
  vaultAudience?: IntegrationKeyVaultAudience;
}

export type CustomKeyStorageScope = "global" | "shared" | "org";

export interface CustomKeyMetadata {
  id: string;
  name: string;
  description?: string;
  permission: "always" | "ask";
  clientAccess: KeyClientAccess;
  createdAt: string;
  updatedAt: string;
  source?: "manual" | "oauth";
  managedBy?: "oauth";
  oauthProvider?: "openai" | "anthropic";
  scope: CustomKeyStorageScope;
  orgScope: IntegrationKeyOrgScope | "global";
  organizationId?: string;
  vaultAudience: IntegrationKeyVaultAudience;
}

export interface CustomKeysVaultContext {
  organizationId: string | null;
  isLocalVault: boolean;
}

export class CustomKeysStorage {
  private static readonly LOCAL_ORG_ID = LOCAL_ORG_ID;
  private static readonly SHARED_ORG_ID = SHARED_ORG_ID;

  private dataDir: string;
  private legacyKeysFile: string;
  private globalKeysFile: string;
  private globalKeys: Map<string, CustomKey> = new Map();
  private sharedKeys: Map<string, CustomKey> = new Map();
  private orgKeys: Map<string, CustomKey> = new Map();
  private activeOrganizationId: string | null = null;
  private legacyMigrationComplete = false;

  constructor() {
    this.dataDir = path.join(app.getPath("userData"), "data");
    this.legacyKeysFile = path.join(this.dataDir, "custom-keys.json");
    this.globalKeysFile = path.join(this.dataDir, "custom-keys.global.json");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadGlobalKeys();
    await this.loadSharedKeys();
    await this.migrateLegacyKeysFileIfNeeded();
    await this.loadOrgKeys(CustomKeysStorage.LOCAL_ORG_ID);
  }

  getActiveOrganizationId(): string | null {
    return this.activeOrganizationId;
  }

  async setActiveOrganization(organizationId: string): Promise<void> {
    const normalizedOrgId = organizationId.trim();
    if (!normalizedOrgId) {
      throw new Error("organizationId is required");
    }

    if (this.activeOrganizationId === normalizedOrgId) {
      await this.loadOrgKeys(normalizedOrgId);
      return;
    }

    if (this.activeOrganizationId) {
      await this.saveOrgKeys(this.activeOrganizationId);
    }

    this.activeOrganizationId = normalizedOrgId;
    await this.migrateLegacyKeysFileIfNeeded();
    await fs.mkdir(path.dirname(this.orgKeysFile(normalizedOrgId)), {
      recursive: true,
    });
    await this.loadOrgKeys(normalizedOrgId);
  }

  /** Align in-memory vault with the active Papr workspace (gateway / profile). */
  async ensureOrganizationVault(
    organizationId: string | null | undefined,
  ): Promise<void> {
    const normalizedOrgId = organizationId?.trim();
    if (
      !normalizedOrgId ||
      normalizedOrgId === CustomKeysStorage.SHARED_ORG_ID ||
      normalizedOrgId === CustomKeysStorage.LOCAL_ORG_ID
    ) {
      return;
    }

    await this.setActiveOrganization(normalizedOrgId);
  }

  private orgKeysFile(organizationId: string): string {
    return path.join(this.dataDir, "orgs", organizationId, "custom-keys.json");
  }

  private encryptValue(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        "[CustomKeys] Encryption not available, using base64 encoding",
      );
      return Buffer.from(value).toString("base64");
    }
    return safeStorage.encryptString(value).toString("base64");
  }

  private decryptValue(encryptedValue: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encryptedValue, "base64").toString("utf-8");
    }
    const buffer = Buffer.from(encryptedValue, "base64");
    return safeStorage.decryptString(buffer);
  }

  private normalizeStoredKeys(
    data: Record<string, CustomKey>,
  ): Map<string, CustomKey> {
    const keys = new Map(Object.entries(data));
    for (const [, key] of keys) {
      if (!key.clientAccess) {
        key.clientAccess = DEFAULT_KEY_CLIENT_ACCESS;
      }
    }
    return keys;
  }

  private async readKeysFile(
    keysFile: string,
  ): Promise<Map<string, CustomKey>> {
    try {
      const exists = await fs
        .access(keysFile)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return new Map();
      }
      const fileContent = await fs.readFile(keysFile, "utf-8");
      const data = JSON.parse(fileContent) as Record<string, CustomKey>;
      return this.normalizeStoredKeys(data);
    } catch (error) {
      console.error(`[CustomKeys] Failed to load keys from ${keysFile}:`, error);
      return new Map();
    }
  }

  private async writeKeysFile(
    keysFile: string,
    keys: Map<string, CustomKey>,
  ): Promise<void> {
    const data = Object.fromEntries(keys);
    const tempFile = `${keysFile}.tmp`;
    await fs.mkdir(path.dirname(keysFile), { recursive: true });
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tempFile, keysFile);
  }

  private async loadGlobalKeys(): Promise<void> {
    this.globalKeys = await this.readKeysFile(this.globalKeysFile);
    if (dedupeCustomKeysByName(this.globalKeys)) {
      await this.writeKeysFile(this.globalKeysFile, this.globalKeys);
    }
    if (this.globalKeys.size > 0) {
      return;
    }

    const legacyExists = await fs
      .access(this.legacyKeysFile)
      .then(() => true)
      .catch(() => false);
    if (!legacyExists) {
      return;
    }

    const legacyKeys = await this.readKeysFile(this.legacyKeysFile);
    for (const [id, key] of legacyKeys) {
      if (isGlobalCustomKeyName(key.name)) {
        this.globalKeys.set(id, key);
      }
    }
    if (this.globalKeys.size > 0) {
      await this.writeKeysFile(this.globalKeysFile, this.globalKeys);
    }
  }

  private async loadSharedKeys(): Promise<void> {
    this.sharedKeys = await this.readKeysFile(
      this.orgKeysFile(CustomKeysStorage.SHARED_ORG_ID),
    );
    if (dedupeCustomKeysByName(this.sharedKeys)) {
      await this.saveSharedKeys();
    }
  }

  private async saveSharedKeys(): Promise<void> {
    await this.writeKeysFile(
      this.orgKeysFile(CustomKeysStorage.SHARED_ORG_ID),
      this.sharedKeys,
    );
  }

  private async loadOrgKeys(organizationId: string): Promise<void> {
    this.orgKeys = await this.loadOrgKeysForOrganization(organizationId);
    if (dedupeCustomKeysByName(this.orgKeys)) {
      await this.saveOrgKeys(organizationId);
    }
  }

  private async persistOrgKeysForOrganization(
    organizationId: string,
    keys: Map<string, CustomKey>,
  ): Promise<void> {
    if (this.activeOrganizationId === organizationId) {
      this.orgKeys = keys;
    }
    await this.writeKeysFile(this.orgKeysFile(organizationId), keys);
  }

  private async loadOrgKeysForOrganization(
    organizationId: string,
  ): Promise<Map<string, CustomKey>> {
    return this.readKeysFile(this.orgKeysFile(organizationId));
  }

  private async saveGlobalKeys(): Promise<void> {
    await this.writeKeysFile(this.globalKeysFile, this.globalKeys);
  }

  private async saveOrgKeys(organizationId: string): Promise<void> {
    await this.writeKeysFile(this.orgKeysFile(organizationId), this.orgKeys);
  }

  private async migrateLegacyKeysFileIfNeeded(): Promise<void> {
    if (this.legacyMigrationComplete) {
      return;
    }

    const legacyExists = await fs
      .access(this.legacyKeysFile)
      .then(() => true)
      .catch(() => false);
    if (!legacyExists) {
      this.legacyMigrationComplete = true;
      return;
    }

    const legacyKeys = await this.readKeysFile(this.legacyKeysFile);
    const globalKeys = new Map(this.globalKeys);
    const sharedKeys = new Map(this.sharedKeys);

    for (const [id, key] of legacyKeys) {
      if (isGlobalCustomKeyName(key.name)) {
        globalKeys.set(id, key);
      } else {
        sharedKeys.set(id, key);
      }
    }

    this.globalKeys = globalKeys;
    this.sharedKeys = sharedKeys;
    await this.saveGlobalKeys();
    await this.saveSharedKeys();

    const backupPath = `${this.legacyKeysFile}.migrated`;
    await fs.rename(this.legacyKeysFile, backupPath).catch(() => undefined);
    this.legacyMigrationComplete = true;
    console.log(
      `[CustomKeys] Migrated legacy keys into shared vault + global vault`,
    );
  }

  getVaultContext(): CustomKeysVaultContext {
    const organizationId = this.activeOrganizationId;
    return {
      organizationId,
      isLocalVault:
        !organizationId || organizationId === CustomKeysStorage.LOCAL_ORG_ID,
    };
  }

  private normalizeKeyName(input: string): string {
    return input.trim().toUpperCase();
  }

  private resolveStorageTarget(input: CustomKeyInput): {
    scope: CustomKeyStorageScope;
    organizationId?: string;
  } {
    if (isGlobalCustomKeyName(input.name)) {
      return { scope: "global" };
    }
    if (isPaprPlatformApiKeyName(input.name)) {
      const organizationId = resolveIntegrationKeyOrganizationId({
        orgScope: "organization",
        organizationId: input.organizationId,
        activeOrganizationId: this.activeOrganizationId,
      });
      return { scope: "org", organizationId };
    }
    if (input.orgScope === "all") {
      return { scope: "shared", organizationId: CustomKeysStorage.SHARED_ORG_ID };
    }
    const organizationId = resolveIntegrationKeyOrganizationId({
      orgScope: input.orgScope,
      organizationId: input.organizationId,
      activeOrganizationId: this.activeOrganizationId,
    });
    return { scope: "org", organizationId };
  }

  private getTargetMap(
    scope: CustomKeyStorageScope,
    organizationId?: string,
  ): Map<string, CustomKey> {
    if (scope === "global") {
      return this.globalKeys;
    }
    if (scope === "shared") {
      return this.sharedKeys;
    }
    const activeOrgId =
      this.activeOrganizationId ?? CustomKeysStorage.LOCAL_ORG_ID;
    const targetOrgId = organizationId ?? activeOrgId;
    if (targetOrgId === activeOrgId) {
      return this.orgKeys;
    }
    throw new Error(
      "Cannot mutate a non-active organization vault in memory. Use persistOrgKeysForOrganization.",
    );
  }

  private findKeyByName(name: string): CustomKey | undefined {
    const orgKey = pickNewestCustomKeyByName(this.orgKeys.values(), name);
    if (orgKey) {
      return orgKey;
    }
    const sharedKey = pickNewestCustomKeyByName(this.sharedKeys.values(), name);
    if (sharedKey) {
      return sharedKey;
    }
    return pickNewestCustomKeyByName(this.globalKeys.values(), name);
  }

  private findKeyEntryByName(
    name: string,
  ): {
    scope: CustomKeyStorageScope;
    organizationId?: string;
    id: string;
    key: CustomKey;
  } | null {
    const orgEntry = pickNewestCustomKeyEntryByName(this.orgKeys.entries(), name);
    if (orgEntry) {
      return {
        scope: "org",
        organizationId: this.activeOrganizationId ?? CustomKeysStorage.LOCAL_ORG_ID,
        id: orgEntry.id,
        key: orgEntry.key,
      };
    }
    const sharedEntry = pickNewestCustomKeyEntryByName(
      this.sharedKeys.entries(),
      name,
    );
    if (sharedEntry) {
      return {
        scope: "shared",
        organizationId: CustomKeysStorage.SHARED_ORG_ID,
        id: sharedEntry.id,
        key: sharedEntry.key,
      };
    }
    const globalEntry = pickNewestCustomKeyEntryByName(
      this.globalKeys.entries(),
      name,
    );
    if (globalEntry) {
      return { scope: "global", id: globalEntry.id, key: globalEntry.key };
    }
    return null;
  }

  private findKeyEntryById(
    keyId: string,
  ): {
    scope: CustomKeyStorageScope;
    organizationId?: string;
    key: CustomKey;
  } | null {
    const orgKey = this.orgKeys.get(keyId);
    if (orgKey) {
      return {
        scope: "org",
        organizationId: this.activeOrganizationId ?? CustomKeysStorage.LOCAL_ORG_ID,
        key: orgKey,
      };
    }
    const sharedKey = this.sharedKeys.get(keyId);
    if (sharedKey) {
      return {
        scope: "shared",
        organizationId: CustomKeysStorage.SHARED_ORG_ID,
        key: sharedKey,
      };
    }
    const globalKey = this.globalKeys.get(keyId);
    if (globalKey) {
      return { scope: "global", key: globalKey };
    }
    return null;
  }

  private async persistKeyScope(
    scope: CustomKeyStorageScope,
    organizationId?: string,
  ): Promise<void> {
    if (scope === "global") {
      await this.saveGlobalKeys();
      return;
    }
    if (scope === "shared") {
      await this.saveSharedKeys();
      return;
    }
    const orgId =
      organizationId ??
      this.activeOrganizationId ??
      CustomKeysStorage.LOCAL_ORG_ID;
    await this.saveOrgKeys(orgId);
  }

  private removeDuplicateKeyNames(
    name: string,
    keepId: string,
    scope: CustomKeyStorageScope,
  ): void {
    const expectedName = this.normalizeKeyName(name);
    const targetMap =
      scope === "global"
        ? this.globalKeys
        : scope === "shared"
          ? this.sharedKeys
          : this.orgKeys;
    for (const [id, key] of targetMap) {
      if (id !== keepId && this.normalizeKeyName(key.name) === expectedName) {
        targetMap.delete(id);
      }
    }
  }

  private mapKeyMetadata(
    key: CustomKey,
    scope: CustomKeyStorageScope,
    organizationId?: string,
  ): CustomKeyMetadata {
    const orgScope: IntegrationKeyOrgScope | "global" =
      scope === "global"
        ? "global"
        : scope === "shared"
          ? "all"
          : "organization";

    return {
      id: key.id,
      name: key.name,
      description: key.description,
      permission: key.permission,
      clientAccess: normalizeKeyClientAccess(key.clientAccess),
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      source: key.source,
      managedBy: key.managedBy,
      oauthProvider: key.oauthProvider,
      scope,
      orgScope,
      organizationId,
      vaultAudience: normalizeIntegrationKeyVaultAudience(key.vaultAudience),
    };
  }

  async listKeys(options?: { orgOnly?: boolean }): Promise<CustomKeyMetadata[]> {
    const hideInternalNamespaceKeys = (keys: CustomKeyMetadata[]) =>
      keys.filter((key) => !isInternalPaprNamespaceApiKeyName(key.name));

    if (options?.orgOnly) {
      const activeOrgId =
        this.activeOrganizationId ?? CustomKeysStorage.LOCAL_ORG_ID;
      const orgList = Array.from(this.orgKeys.values()).map((key) =>
        this.mapKeyMetadata(key, "org", activeOrgId),
      );
      const sharedList = Array.from(this.sharedKeys.values()).map((key) =>
        this.mapKeyMetadata(key, "shared", CustomKeysStorage.SHARED_ORG_ID),
      );
      return hideInternalNamespaceKeys([...orgList, ...sharedList]);
    }

    const merged: CustomKeyMetadata[] = [];
    for (const key of this.globalKeys.values()) {
      merged.push(this.mapKeyMetadata(key, "global"));
    }
    for (const key of this.sharedKeys.values()) {
      merged.push(
        this.mapKeyMetadata(key, "shared", CustomKeysStorage.SHARED_ORG_ID),
      );
    }
    for (const key of this.orgKeys.values()) {
      merged.push(
        this.mapKeyMetadata(
          key,
          "org",
          this.activeOrganizationId ?? CustomKeysStorage.LOCAL_ORG_ID,
        ),
      );
    }
    return hideInternalNamespaceKeys(merged);
  }

  async getKey(keyId: string): Promise<string | null> {
    const entry = this.findKeyEntryById(keyId);
    if (!entry) return null;

    try {
      return this.decryptValue(entry.key.encryptedValue);
    } catch (error) {
      console.error(`[CustomKeys] Failed to decrypt key ${keyId}:`, error);
      return null;
    }
  }

  async getKeyByName(name: string): Promise<string | null> {
    let key = this.findKeyByName(name);
    if (!key && this.activeOrganizationId) {
      await this.loadOrgKeys(this.activeOrganizationId);
      key = this.findKeyByName(name);
    }
    if (!key) return null;

    try {
      return this.decryptValue(key.encryptedValue);
    } catch (error) {
      console.error(`[CustomKeys] Failed to decrypt key ${name}:`, error);
      return null;
    }
  }

  async getKeyMetadataByName(
    name: string,
  ): Promise<Omit<CustomKey, "encryptedValue"> | null> {
    const key = this.findKeyByName(name);
    if (!key) return null;

    return {
      id: key.id,
      name: key.name,
      description: key.description,
      permission: key.permission,
      clientAccess: normalizeKeyClientAccess(key.clientAccess),
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      source: key.source,
      managedBy: key.managedBy,
      oauthProvider: key.oauthProvider,
    };
  }

  async addKey(input: CustomKeyInput): Promise<CustomKey> {
    const now = new Date().toISOString();
    const target = this.resolveStorageTarget(input);
    let existing = this.findKeyEntryByName(input.name);

    if (
      existing &&
      isPaprPlatformApiKeyName(input.name) &&
      existing.scope !== target.scope
    ) {
      await this.deleteKey(existing.id);
      existing = null;
    }

    if (existing) {
      const updatedKey: CustomKey = {
        ...existing.key,
        encryptedValue: this.encryptValue(input.value),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.permission && { permission: input.permission }),
        ...(input.clientAccess !== undefined && {
          clientAccess: normalizeKeyClientAccess(input.clientAccess),
        }),
        ...(input.vaultAudience !== undefined && {
          vaultAudience: normalizeIntegrationKeyVaultAudience(input.vaultAudience),
        }),
        updatedAt: now,
      };

      if (existing.scope === "org" && existing.organizationId !== target.organizationId) {
        throw new Error(
          `Key ${input.name} already exists in another organization vault`,
        );
      }
      if (existing.scope !== target.scope) {
        throw new Error(
          `Key ${input.name} already exists with a different org scope`,
        );
      }

      if (target.scope === "org" && target.organizationId !== this.activeOrganizationId) {
        const orgKeys = await this.loadOrgKeysForOrganization(target.organizationId!);
        orgKeys.set(existing.id, updatedKey);
        dedupeCustomKeysByName(orgKeys);
        await this.persistOrgKeysForOrganization(target.organizationId!, orgKeys);
      } else {
        const targetMap = this.getTargetMap(target.scope, target.organizationId);
        targetMap.set(existing.id, updatedKey);
        this.removeDuplicateKeyNames(input.name, existing.id, target.scope);
        await this.persistKeyScope(target.scope, target.organizationId);
      }

      return updatedKey;
    }

    const id = `key-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key: CustomKey = {
      id,
      name: input.name,
      description: input.description,
      permission: input.permission || "always",
      clientAccess: normalizeKeyClientAccess(input.clientAccess),
      encryptedValue: this.encryptValue(input.value),
      createdAt: now,
      updatedAt: now,
      vaultAudience: normalizeIntegrationKeyVaultAudience(input.vaultAudience),
    };

    if (target.scope === "org" && target.organizationId !== this.activeOrganizationId) {
      await fs.mkdir(path.dirname(this.orgKeysFile(target.organizationId!)), {
        recursive: true,
      });
      const orgKeys = await this.loadOrgKeysForOrganization(target.organizationId!);
      orgKeys.set(id, key);
      dedupeCustomKeysByName(orgKeys);
      await this.persistOrgKeysForOrganization(target.organizationId!, orgKeys);
    } else {
      const targetMap = this.getTargetMap(target.scope, target.organizationId);
      targetMap.set(id, key);
      await this.persistKeyScope(target.scope, target.organizationId);
    }

    console.log(
      `[CustomKeys] Added key: ${input.name} (scope: ${target.scope}, org: ${target.organizationId ?? "global"})`,
    );
    return key;
  }

  async updateKey(
    keyId: string,
    updates: Partial<CustomKeyInput>,
  ): Promise<CustomKey | null> {
    const entry = this.findKeyEntryById(keyId);
    if (!entry) return null;

    const nextTarget =
      updates.orgScope !== undefined || updates.organizationId !== undefined
        ? this.resolveStorageTarget({
            name: updates.name ?? entry.key.name,
            value: updates.value ?? "",
            orgScope: updates.orgScope,
            organizationId: updates.organizationId,
          })
        : {
            scope: entry.scope,
            organizationId: entry.organizationId,
          };

    const updatedKey: CustomKey = {
      ...entry.key,
      ...(updates.name && { name: updates.name }),
      ...(updates.description !== undefined && {
        description: updates.description,
      }),
      ...(updates.permission && { permission: updates.permission }),
      ...(updates.clientAccess !== undefined && {
        clientAccess: normalizeKeyClientAccess(updates.clientAccess),
      }),
      ...(updates.value && {
        encryptedValue: this.encryptValue(updates.value),
      }),
      ...(updates.vaultAudience !== undefined && {
        vaultAudience: normalizeIntegrationKeyVaultAudience(updates.vaultAudience),
      }),
      updatedAt: new Date().toISOString(),
    };

    const scopeChanged =
      nextTarget.scope !== entry.scope ||
      nextTarget.organizationId !== entry.organizationId;

    if (scopeChanged) {
      const preservedValue = updates.value ?? (await this.getKey(keyId));
      if (!preservedValue) {
        return null;
      }
      await this.deleteKey(keyId);
      return this.addKey({
        name: updatedKey.name,
        value: preservedValue,
        description: updatedKey.description,
        permission: updatedKey.permission,
        clientAccess: updatedKey.clientAccess,
        orgScope:
          updates.orgScope ??
          (nextTarget.scope === "shared" ? "all" : "organization"),
        organizationId: nextTarget.organizationId,
        vaultAudience:
          updates.vaultAudience ?? updatedKey.vaultAudience ?? "user",
      });
    }

    if (entry.scope === "org" && entry.organizationId !== this.activeOrganizationId) {
      const orgKeys = await this.loadOrgKeysForOrganization(entry.organizationId!);
      orgKeys.set(keyId, updatedKey);
      await this.persistOrgKeysForOrganization(entry.organizationId!, orgKeys);
      return updatedKey;
    }

    const targetMap = this.getTargetMap(entry.scope, entry.organizationId);
    targetMap.set(keyId, updatedKey);
    await this.persistKeyScope(entry.scope, entry.organizationId);
    return updatedKey;
  }

  async deleteKey(keyId: string): Promise<boolean> {
    const entry = this.findKeyEntryById(keyId);
    if (!entry) {
      return false;
    }

    if (entry.scope === "org" && entry.organizationId !== this.activeOrganizationId) {
      const orgKeys = await this.loadOrgKeysForOrganization(entry.organizationId!);
      const existed = orgKeys.delete(keyId);
      if (existed) {
        await this.persistOrgKeysForOrganization(entry.organizationId!, orgKeys);
      }
      return existed;
    }

    const targetMap = this.getTargetMap(entry.scope, entry.organizationId);
    const existed = targetMap.delete(keyId);
    if (existed) {
      await this.persistKeyScope(entry.scope, entry.organizationId);
      console.log(`[CustomKeys] Deleted key: ${keyId}`);
    }
    return existed;
  }

  async resolvePlaceholders(
    text: string,
    allowedKeys?: string[],
  ): Promise<string> {
    let resolved = text;
    const seenNames = new Set<string>();
    const keysInPriorityOrder = [
      ...this.orgKeys.values(),
      ...this.sharedKeys.values(),
      ...this.globalKeys.values(),
    ];

    for (const key of keysInPriorityOrder) {
      if (seenNames.has(key.name)) {
        continue;
      }
      seenNames.add(key.name);

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

  getRequiredKeys(text: string): string[] {
    const pattern = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
    const matches = text.matchAll(pattern);
    return Array.from(new Set(Array.from(matches, (m) => m[1])));
  }

  sanitizeText(text: string, resolvedKeys: Record<string, string>): string {
    let sanitized = text;

    for (const [keyName, value] of Object.entries(resolvedKeys)) {
      if (value && value.length > 10) {
        const valueRegex = new RegExp(
          value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "g",
        );
        sanitized = sanitized.replace(valueRegex, `***${keyName}_REDACTED***`);
      }
    }

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
