/**
 * Key Permissions Storage
 * 
 * Manages permission settings for environment API keys.
 * Determines if keys require user approval before use in tools.
 * 
 * Separate from CustomKeysStorage because:
 * - Custom keys have permission in their definition
 * - Environment keys need runtime permission tracking
 */

import Store from "electron-store";

export type KeyPermission = "ask" | "always";

export interface KeyPermissionsData {
  [keyName: string]: KeyPermission;
}

const DEFAULT_KEY_PERMISSIONS: KeyPermissionsData = {};

export class KeyPermissionsStorage {
  private store: Store<KeyPermissionsData>;

  constructor() {
    this.store = new Store<KeyPermissionsData>({
      name: "env-key-permissions",
      defaults: DEFAULT_KEY_PERMISSIONS,
      encryptionKey: "paprwork-v2-key-permissions",
    });
  }

  /**
   * Get permission for an environment key
   * @returns 'ask' (default) or 'always'
   */
  getPermission(keyName: string): KeyPermission {
    return this.store.get(keyName, "ask");
  }

  /**
   * Set permission for an environment key
   */
  setPermission(keyName: string, permission: KeyPermission): void {
    this.store.set(keyName, permission);
  }

  /**
   * Get all key permissions
   */
  getAll(): KeyPermissionsData {
    return this.store.store;
  }

  /**
   * Check if key should prompt for permission
   * @returns true if should ask, false if always allowed
   */
  shouldAskPermission(keyName: string): boolean {
    return this.getPermission(keyName) === "ask";
  }

  /**
   * Reset permission for a key (back to 'ask')
   */
  resetPermission(keyName: string): void {
    this.store.delete(keyName);
  }

  /**
   * Reset all permissions
   */
  resetAll(): void {
    this.store.clear();
  }

  /**
   * Get keys that are set to 'always' allow
   */
  getAlwaysAllowedKeys(): string[] {
    const all = this.getAll();
    return Object.entries(all)
      .filter(([_, permission]) => permission === "always")
      .map(([keyName]) => keyName);
  }

  /**
   * Check if key has been configured (has any permission set)
   */
  hasPermissionSet(keyName: string): boolean {
    return this.store.has(keyName);
  }
}
