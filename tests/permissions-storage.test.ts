/**
 * Permissions Storage Tests
 * 
 * Tests for KeyPermissionsStorage and permission settings
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { KeyPermissionsStorage } from '../src/core/storage/KeyPermissionsStorage.js';
import { SettingsStorage } from '../src/core/storage/SettingsStorage.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('KeyPermissionsStorage', () => {
  let storage: KeyPermissionsStorage;
  const testDataPath = path.join(os.tmpdir(), '.paprwork-test-permissions');

  beforeEach(() => {
    storage = new KeyPermissionsStorage(testDataPath);
  });

  afterEach(() => {
    // Clean up test files
    try {
      const storePath = path.join(testDataPath, 'env-key-permissions.json');
      if (fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      if (fs.existsSync(testDataPath)) {
        fs.rmdirSync(testDataPath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Permission Management', () => {
    test('should start with default "ask" permission', () => {
      const permission = storage.getPermission('NEW_KEY');
      expect(permission).toBe('ask');
    });

    test('should set and get permission', () => {
      storage.setPermission('TEST_KEY', 'always');
      
      const permission = storage.getPermission('TEST_KEY');
      expect(permission).toBe('always');
    });

    test('should update existing permission', () => {
      storage.setPermission('TEST_KEY', 'ask');
      expect(storage.getPermission('TEST_KEY')).toBe('ask');
      
      storage.setPermission('TEST_KEY', 'always');
      expect(storage.getPermission('TEST_KEY')).toBe('always');
    });

    test('should reset permission to default', () => {
      storage.setPermission('TEST_KEY', 'always');
      expect(storage.getPermission('TEST_KEY')).toBe('always');
      
      storage.resetPermission('TEST_KEY');
      expect(storage.getPermission('TEST_KEY')).toBe('ask');
    });

    test('should handle multiple keys', () => {
      storage.setPermission('KEY1', 'always');
      storage.setPermission('KEY2', 'ask');
      storage.setPermission('KEY3', 'always');
      
      expect(storage.getPermission('KEY1')).toBe('always');
      expect(storage.getPermission('KEY2')).toBe('ask');
      expect(storage.getPermission('KEY3')).toBe('always');
    });
  });

  describe('Permission Queries', () => {
    test('should check if permission needed (ask)', () => {
      storage.setPermission('TEST_KEY', 'ask');
      expect(storage.shouldAskPermission('TEST_KEY')).toBe(true);
    });

    test('should check if permission needed (always)', () => {
      storage.setPermission('TEST_KEY', 'always');
      expect(storage.shouldAskPermission('TEST_KEY')).toBe(false);
    });

    test('should default to ask for new keys', () => {
      expect(storage.shouldAskPermission('NEVER_SET_KEY')).toBe(true);
    });

    test('should get all always-allowed keys', () => {
      storage.setPermission('KEY1', 'always');
      storage.setPermission('KEY2', 'ask');
      storage.setPermission('KEY3', 'always');
      
      const alwaysAllowed = storage.getAlwaysAllowedKeys();
      
      expect(alwaysAllowed).toContain('KEY1');
      expect(alwaysAllowed).toContain('KEY3');
      expect(alwaysAllowed).not.toContain('KEY2');
      expect(alwaysAllowed.length).toBe(2);
    });

    test('should return all permissions', () => {
      storage.setPermission('KEY1', 'always');
      storage.setPermission('KEY2', 'ask');
      
      const all = storage.getAll();
      
      expect(all.KEY1).toBe('always');
      expect(all.KEY2).toBe('ask');
    });
  });

  describe('Persistence', () => {
    test('should persist permissions across instances', () => {
      storage.setPermission('PERSIST_KEY', 'always');
      
      // Create new instance
      const newStorage = new KeyPermissionsStorage(testDataPath);
      
      expect(newStorage.getPermission('PERSIST_KEY')).toBe('always');
    });

    test('should reset all permissions', () => {
      storage.setPermission('KEY1', 'always');
      storage.setPermission('KEY2', 'always');
      
      storage.resetAll();
      
      expect(storage.getPermission('KEY1')).toBe('ask');
      expect(storage.getPermission('KEY2')).toBe('ask');
    });
  });
});

describe('SettingsStorage - Permission Settings', () => {
  let storage: SettingsStorage;
  const testDataPath = path.join(os.tmpdir(), '.paprwork-test-settings');

  beforeEach(() => {
    storage = new SettingsStorage(testDataPath);
  });

  afterEach(() => {
    // Clean up test files
    try {
      const storePath = path.join(testDataPath, 'settings.json');
      if (fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      if (fs.existsSync(testDataPath)) {
        fs.rmdirSync(testDataPath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Permission Level', () => {
    test('should default to "open"', () => {
      const level = storage.getPermissionLevel();
      expect(level).toBe('open');
    });

    test('should set and get permission level', () => {
      storage.setPermissionLevel('strict');
      expect(storage.getPermissionLevel()).toBe('strict');
      
      storage.setPermissionLevel('open');
      expect(storage.getPermissionLevel()).toBe('open');
    });
  });

  describe('Permission Settings', () => {
    test('should get default permission settings', () => {
      const settings = storage.getPermissionSettings();
      
      expect(settings.permissionLevel).toBe('open');
      expect(settings.requireConfirmForBash).toBe(false);
      expect(settings.requireConfirmForFileWrite).toBe(false);
      expect(settings.requireConfirmForBrowser).toBe(false);
    });

    test('should update permission settings', () => {
      storage.setPermissionSettings({
        requireConfirmForBash: true,
        requireConfirmForFileWrite: true,
      });
      
      const settings = storage.getPermissionSettings();
      
      expect(settings.requireConfirmForBash).toBe(true);
      expect(settings.requireConfirmForFileWrite).toBe(true);
      expect(settings.requireConfirmForBrowser).toBe(false); // Unchanged
    });

    test('should update permission level via settings', () => {
      storage.setPermissionSettings({
        permissionLevel: 'strict',
      });
      
      const settings = storage.getPermissionSettings();
      expect(settings.permissionLevel).toBe('strict');
    });
  });

  describe('Tool Permissions', () => {
    test('should check tool permission (bash)', () => {
      storage.setPermissionSettings({ requireConfirmForBash: true });
      expect(storage.getToolPermission('bash')).toBe(true);
    });

    test('should check tool permission (fileWrite)', () => {
      storage.setPermissionSettings({ requireConfirmForFileWrite: false });
      expect(storage.getToolPermission('fileWrite')).toBe(false);
    });

    test('should check tool permission (browser)', () => {
      storage.setPermissionSettings({ requireConfirmForBrowser: true });
      expect(storage.getToolPermission('browser')).toBe(true);
    });
  });

  describe('Persistence', () => {
    test('should persist permission settings', () => {
      storage.setPermissionSettings({
        permissionLevel: 'strict',
        requireConfirmForBash: true,
        requireConfirmForFileWrite: true,
      });
      
      // Create new instance
      const newStorage = new SettingsStorage(testDataPath);
      const settings = newStorage.getPermissionSettings();
      
      expect(settings.permissionLevel).toBe('strict');
      expect(settings.requireConfirmForBash).toBe(true);
      expect(settings.requireConfirmForFileWrite).toBe(true);
    });
  });
});
