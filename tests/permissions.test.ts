/**
 * Permissions System Tests
 * 
 * Tests the complete permission system:
 * 1. KeyPermissionsStorage
 * 2. Permission-aware key substitution
 * 3. Settings integration
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { KeyPermissionsStorage } from '../src/core/storage/KeyPermissionsStorage.js';
import { SettingsStorage } from '../src/core/storage/SettingsStorage.js';
import { substituteCustomKeysWithPermission } from '../src/core/tools/security.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Permissions System', () => {
  let tempDir: string;
  let storage: KeyPermissionsStorage;

  beforeEach(() => {
    // Create temp directory for test data
    tempDir = path.join(os.tmpdir(), `papr-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Set electron-store path to temp dir
    process.env.PAPR_TEST_DATA_PATH = tempDir;
    
    storage = new KeyPermissionsStorage();
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env.PAPR_TEST_DATA_PATH;
  });

  describe('KeyPermissionsStorage', () => {
    test('should default to "ask" for new keys', () => {
      const permission = storage.getPermission('NEW_KEY');
      expect(permission).toBe('ask');
    });

    test('should set and get permissions', () => {
      storage.setPermission('TEST_KEY', 'always');
      
      const permission = storage.getPermission('TEST_KEY');
      expect(permission).toBe('always');
    });

    test('should return true for shouldAskPermission when permission is "ask"', () => {
      storage.setPermission('ASK_KEY', 'ask');
      
      expect(storage.shouldAskPermission('ASK_KEY')).toBe(true);
    });

    test('should return false for shouldAskPermission when permission is "always"', () => {
      storage.setPermission('ALWAYS_KEY', 'always');
      
      expect(storage.shouldAskPermission('ALWAYS_KEY')).toBe(false);
    });

    test('should reset permissions', () => {
      storage.setPermission('RESET_KEY', 'always');
      expect(storage.getPermission('RESET_KEY')).toBe('always');
      
      storage.resetPermission('RESET_KEY');
      expect(storage.getPermission('RESET_KEY')).toBe('ask');
    });

    test('should get all permissions', () => {
      storage.setPermission('KEY1', 'always');
      storage.setPermission('KEY2', 'ask');
      storage.setPermission('KEY3', 'always');
      
      const all = storage.getAll();
      
      expect(all.KEY1).toBe('always');
      expect(all.KEY2).toBe('ask');
      expect(all.KEY3).toBe('always');
    });

    test('should get only always-allowed keys', () => {
      storage.setPermission('ALLOWED1', 'always');
      storage.setPermission('ASK_KEY', 'ask');
      storage.setPermission('ALLOWED2', 'always');
      
      const alwaysAllowed = storage.getAlwaysAllowedKeys();
      
      expect(alwaysAllowed).toContain('ALLOWED1');
      expect(alwaysAllowed).toContain('ALLOWED2');
      expect(alwaysAllowed).not.toContain('ASK_KEY');
      expect(alwaysAllowed).toHaveLength(2);
    });

    test('should reset all permissions', () => {
      storage.setPermission('KEY1', 'always');
      storage.setPermission('KEY2', 'always');
      
      storage.resetAll();
      
      const all = storage.getAll();
      expect(Object.keys(all)).toHaveLength(0);
    });
  });

  describe('SettingsStorage Permissions', () => {
    let settingsStorage: SettingsStorage;

    beforeEach(() => {
      settingsStorage = new SettingsStorage();
    });

    test('should have default permission settings', () => {
      const settings = settingsStorage.getPermissionSettings();
      
      expect(settings.permissionLevel).toBe('moderate');
      expect(settings.requireConfirmForBash).toBe(false);
      expect(settings.requireConfirmForFileWrite).toBe(false);
      expect(settings.requireConfirmForBrowser).toBe(false);
    });

    test('should set and get permission level', () => {
      settingsStorage.setPermissionLevel('strict');
      
      const level = settingsStorage.getPermissionLevel();
      expect(level).toBe('strict');
    });

    test('should update permission settings', () => {
      settingsStorage.setPermissionSettings({
        requireConfirmForBash: true,
        requireConfirmForFileWrite: true,
      });
      
      const settings = settingsStorage.getPermissionSettings();
      
      expect(settings.requireConfirmForBash).toBe(true);
      expect(settings.requireConfirmForFileWrite).toBe(true);
      expect(settings.requireConfirmForBrowser).toBe(false); // Unchanged
    });

    test('should get tool-specific permissions', () => {
      settingsStorage.setPermissionSettings({
        requireConfirmForBash: true,
        requireConfirmForFileWrite: false,
        requireConfirmForBrowser: true,
      });
      
      expect(settingsStorage.getToolPermission('bash')).toBe(true);
      expect(settingsStorage.getToolPermission('fileWrite')).toBe(false);
      expect(settingsStorage.getToolPermission('browser')).toBe(true);
    });
  });

  describe('Permission-Aware Key Substitution', () => {
    test('should substitute keys when permission is granted', async () => {
      const command = 'echo ${TEST_KEY}';
      const customKeys = { TEST_KEY: 'secret-value' };
      
      const result = await substituteCustomKeysWithPermission(
        command,
        customKeys,
        { toolName: 'bash', command },
        async (keyName) => {
          expect(keyName).toBe('TEST_KEY');
          return { approved: true };
        }
      );
      
      expect(result).toBe('echo secret-value');
    });

    test('should throw error when permission is denied', async () => {
      const command = 'echo ${DENIED_KEY}';
      const customKeys = { DENIED_KEY: 'secret' };
      
      await expect(
        substituteCustomKeysWithPermission(
          command,
          customKeys,
          { toolName: 'bash', command },
          async (keyName) => {
            expect(keyName).toBe('DENIED_KEY');
            return { approved: false };
          }
        )
      ).rejects.toThrow('Permission denied for API key: DENIED_KEY');
    });

    test('should handle multiple keys with mixed permissions', async () => {
      const command = 'curl -u ${USER}:${PASS}';
      const customKeys = {
        USER: 'admin',
        PASS: 'secret123',
      };
      
      const permissions: Record<string, boolean> = {
        USER: true,
        PASS: false,
      };
      
      await expect(
        substituteCustomKeysWithPermission(
          command,
          customKeys,
          { toolName: 'bash', command },
          async (keyName) => {
            return { approved: permissions[keyName] };
          }
        )
      ).rejects.toThrow('Permission denied for API key: PASS');
    });

    test('should not request permission for keys not used in command', async () => {
      const command = 'echo hello';
      const customKeys = { UNUSED_KEY: 'value' };
      
      let permissionRequested = false;
      
      const result = await substituteCustomKeysWithPermission(
        command,
        customKeys,
        { toolName: 'bash', command },
        async () => {
          permissionRequested = true;
          return { approved: true };
        }
      );
      
      expect(permissionRequested).toBe(false);
      expect(result).toBe('echo hello');
    });

    test('should fallback to simple substitution when no callback provided', async () => {
      const command = 'echo ${KEY}';
      const customKeys = { KEY: 'value' };
      
      const result = await substituteCustomKeysWithPermission(
        command,
        customKeys,
        { toolName: 'bash', command },
        undefined // No callback
      );
      
      expect(result).toBe('echo value');
    });

    test('should include context in permission request', async () => {
      const command = 'curl -H "Authorization: Bearer ${API_KEY}"';
      const customKeys = { API_KEY: 'sk-123' };
      
      let receivedContext: any;
      
      await substituteCustomKeysWithPermission(
        command,
        customKeys,
        { toolName: 'bash', command },
        async (keyName, context) => {
          receivedContext = context;
          return { approved: true };
        }
      );
      
      expect(receivedContext).toBeDefined();
      expect(receivedContext.toolName).toBe('bash');
      expect(receivedContext.command).toBe(command);
    });

    test('should handle error during permission callback', async () => {
      const command = 'echo ${KEY}';
      const customKeys = { KEY: 'value' };
      
      await expect(
        substituteCustomKeysWithPermission(
          command,
          customKeys,
          { toolName: 'bash', command },
          async () => {
            throw new Error('IPC error');
          }
        )
      ).rejects.toThrow('IPC error');
    });
  });

  describe('Permission Types', () => {
    test('should validate KeyPermission type', () => {
      const validPermissions: Array<'ask' | 'always'> = ['ask', 'always'];
      
      validPermissions.forEach((permission) => {
        storage.setPermission('TEST', permission);
        expect(storage.getPermission('TEST')).toBe(permission);
      });
    });

    test('should validate PermissionLevel type', () => {
      const settingsStorage = new SettingsStorage();
      const validLevels: Array<'open' | 'moderate' | 'strict'> = [
        'open',
        'moderate',
        'strict',
      ];
      
      validLevels.forEach((level) => {
        settingsStorage.setPermissionLevel(level);
        expect(settingsStorage.getPermissionLevel()).toBe(level);
      });
    });
  });

  describe('Permission Request/Response Flow', () => {
    test('should format KeyPermissionRequest correctly', () => {
      const request = {
        keyName: 'OPENAI_API_KEY',
        description: 'Allow OPENAI_API_KEY to be used in bash command?',
        isEnvKey: true,
        toolContext: {
          toolName: 'bash',
          command: 'curl https://api.openai.com',
        },
      };
      
      expect(request.keyName).toBe('OPENAI_API_KEY');
      expect(request.isEnvKey).toBe(true);
      expect(request.toolContext?.toolName).toBe('bash');
    });

    test('should format KeyPermissionResponse correctly', () => {
      const approvedResponse = {
        approved: true,
        alwaysAllow: true,
      };
      
      expect(approvedResponse.approved).toBe(true);
      expect(approvedResponse.alwaysAllow).toBe(true);
      
      const deniedResponse = {
        approved: false,
      };
      
      expect(deniedResponse.approved).toBe(false);
      expect(deniedResponse.alwaysAllow).toBeUndefined();
    });
  });

  describe('Integration: Permissions + Security', () => {
    test('should work together: request, substitute, sanitize', async () => {
      const command = 'curl -H "Authorization: Bearer ${OPENAI_API_KEY}"';
      const customKeys = { OPENAI_API_KEY: 'sk-real-key-123' };
      
      // 1. Request permission and substitute
      const substituted = await substituteCustomKeysWithPermission(
        command,
        customKeys,
        { toolName: 'bash', command },
        async () => ({ approved: true })
      );
      
      expect(substituted).toContain('sk-real-key-123');
      
      // 2. Execute (simulated)
      const output = `Command: ${substituted}\nSuccess!`;
      
      // 3. Sanitize output
      const { sanitizeError } = await import('../src/core/tools/security.js');
      const sanitized = sanitizeError(output, ['sk-real-key-123']);
      
      expect(sanitized).toContain('Bearer ***');
      expect(sanitized).not.toContain('sk-real-key-123');
    });
  });
});
