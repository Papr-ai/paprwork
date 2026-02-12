/**
 * Permission-Aware Key Substitution Tests
 * 
 * Tests for substituteCustomKeysWithPermission and permission flow
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  substituteCustomKeys,
  substituteCustomKeysWithPermission,
} from '../src/core/tools/security.js';
import type { KeyPermissionRequest, KeyPermissionResponse } from '../src/core/types/permissions.js';

describe('Permission-Aware Key Substitution', () => {
  const testKeys = {
    OPENAI_API_KEY: 'sk-test-key-123',
    ANTHROPIC_API_KEY: 'sk-ant-456',
    CUSTOM_SECRET: 'secret-789',
  };

  const testContext = {
    toolName: 'bash',
    command: 'test command',
  };

  describe('No Permission Callback', () => {
    test('should fall back to simple substitution without callback', async () => {
      const command = 'echo ${OPENAI_API_KEY}';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext
        // No callback provided
      );
      
      expect(result).toBe('echo sk-test-key-123');
    });

    test('should handle multiple keys without callback', async () => {
      const command = 'curl -u "${OPENAI_API_KEY}:${ANTHROPIC_API_KEY}"';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext
      );
      
      expect(result).toBe('curl -u "sk-test-key-123:sk-ant-456"');
    });

    test('should not modify command without keys', async () => {
      const command = 'echo "hello world"';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext
      );
      
      expect(result).toBe(command);
    });
  });

  describe('With Permission Callback', () => {
    test('should request permission for single key', async () => {
      const command = 'echo ${OPENAI_API_KEY}';
      const requestedKeys: string[] = [];
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async (keyName, context) => {
          requestedKeys.push(keyName);
          return { approved: true };
        }
      );
      
      expect(requestedKeys).toEqual(['OPENAI_API_KEY']);
      expect(result).toBe('echo sk-test-key-123');
    });

    test('should request permission for multiple keys', async () => {
      const command = 'curl -u "${OPENAI_API_KEY}:${ANTHROPIC_API_KEY}"';
      const requestedKeys: string[] = [];
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async (keyName) => {
          requestedKeys.push(keyName);
          return { approved: true };
        }
      );
      
      expect(requestedKeys).toContain('OPENAI_API_KEY');
      expect(requestedKeys).toContain('ANTHROPIC_API_KEY');
      expect(result).toBe('curl -u "sk-test-key-123:sk-ant-456"');
    });

    test('should pass correct context to callback', async () => {
      const command = 'curl ${OPENAI_API_KEY}';
      let receivedContext: any;
      
      await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async (keyName, context) => {
          receivedContext = context;
          return { approved: true };
        }
      );
      
      expect(receivedContext).toEqual(testContext);
      expect(receivedContext.toolName).toBe('bash');
      expect(receivedContext.command).toBe('test command');
    });

    test('should throw error if permission denied', async () => {
      const command = 'echo ${OPENAI_API_KEY}';
      
      await expect(
        substituteCustomKeysWithPermission(
          command,
          testKeys,
          testContext,
          async () => ({ approved: false })
        )
      ).rejects.toThrow(/Permission denied for API key: OPENAI_API_KEY/);
    });

    test('should throw error with context on denial', async () => {
      const command = 'curl ${ANTHROPIC_API_KEY}';
      
      await expect(
        substituteCustomKeysWithPermission(
          command,
          testKeys,
          { toolName: 'bash', command: 'sensitive command' },
          async () => ({ approved: false })
        )
      ).rejects.toThrow(/The key was needed for: bash/);
    });

    test('should handle mixed approval (some denied)', async () => {
      const command = 'curl -u "${OPENAI_API_KEY}:${ANTHROPIC_API_KEY}"';
      
      await expect(
        substituteCustomKeysWithPermission(
          command,
          testKeys,
          testContext,
          async (keyName) => {
            // Approve OPENAI_API_KEY, deny ANTHROPIC_API_KEY
            return { approved: keyName === 'OPENAI_API_KEY' };
          }
        )
      ).rejects.toThrow(/Permission denied for API key: ANTHROPIC_API_KEY/);
    });

    test('should not request permission for unused keys', async () => {
      const command = 'echo ${OPENAI_API_KEY}';
      const requestedKeys: string[] = [];
      
      const largeKeySet = {
        ...testKeys,
        UNUSED_KEY_1: 'value1',
        UNUSED_KEY_2: 'value2',
        UNUSED_KEY_3: 'value3',
      };
      
      await substituteCustomKeysWithPermission(
        command,
        largeKeySet,
        testContext,
        async (keyName) => {
          requestedKeys.push(keyName);
          return { approved: true };
        }
      );
      
      expect(requestedKeys).toEqual(['OPENAI_API_KEY']);
      expect(requestedKeys.length).toBe(1);
    });

    test('should handle same key used multiple times', async () => {
      const command = 'echo ${OPENAI_API_KEY} && curl ${OPENAI_API_KEY}';
      const requestCount: Record<string, number> = {};
      
      await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async (keyName) => {
          requestCount[keyName] = (requestCount[keyName] || 0) + 1;
          return { approved: true };
        }
      );
      
      // Should only request permission once per unique key
      expect(requestCount.OPENAI_API_KEY).toBe(1);
    });
  });

  describe('Error Handling', () => {
    test('should handle callback throwing error', async () => {
      const command = 'echo ${OPENAI_API_KEY}';
      
      await expect(
        substituteCustomKeysWithPermission(
          command,
          testKeys,
          testContext,
          async () => {
            throw new Error('Network error');
          }
        )
      ).rejects.toThrow(/Network error/);
    });

    test('should handle callback returning invalid response', async () => {
      const command = 'echo ${OPENAI_API_KEY}';
      
      // TypeScript would catch this, but test runtime behavior
      await expect(
        substituteCustomKeysWithPermission(
          command,
          testKeys,
          testContext,
          async () => null as any
        )
      ).rejects.toThrow();
    });

    test('should handle missing key in keys map', async () => {
      const command = 'echo ${MISSING_KEY}';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async () => ({ approved: true })
      );
      
      // Should not modify command if key doesn't exist
      expect(result).toBe(command);
    });
  });

  describe('Real-World Scenarios', () => {
    test('should handle OpenAI API call', async () => {
      const command = 'curl https://api.openai.com/v1/models -H "Authorization: Bearer ${OPENAI_API_KEY}"';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        { toolName: 'bash', command },
        async (keyName, context) => {
          expect(keyName).toBe('OPENAI_API_KEY');
          expect(context.command).toBe(command);
          return { approved: true };
        }
      );
      
      expect(result).toContain('Bearer sk-test-key-123');
      expect(result).not.toContain('${OPENAI_API_KEY}');
    });

    test('should handle curl with multiple headers', async () => {
      const command = 'curl example.com -H "X-API-Key: ${OPENAI_API_KEY}" -H "X-Secret: ${CUSTOM_SECRET}"';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async () => ({ approved: true })
      );
      
      expect(result).toContain('X-API-Key: sk-test-key-123');
      expect(result).toContain('X-Secret: secret-789');
    });

    test('should handle Python script with env vars', async () => {
      const command = 'OPENAI_API_KEY=${OPENAI_API_KEY} python script.py';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async () => ({ approved: true })
      );
      
      expect(result).toBe('OPENAI_API_KEY=sk-test-key-123 python script.py');
    });

    test('should handle git commands with credentials', async () => {
      const command = 'git clone https://${GIT_TOKEN}@github.com/user/repo.git';
      const keys = { GIT_TOKEN: 'ghp_token123' };
      
      const result = await substituteCustomKeysWithPermission(
        command,
        keys,
        { toolName: 'bash' },
        async () => ({ approved: true })
      );
      
      expect(result).toBe('git clone https://ghp_token123@github.com/user/repo.git');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty command', async () => {
      const result = await substituteCustomKeysWithPermission(
        '',
        testKeys,
        testContext,
        async () => ({ approved: true })
      );
      
      expect(result).toBe('');
    });

    test('should handle command with no keys', async () => {
      const command = 'echo hello world';
      let callbackCalled = false;
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async () => {
          callbackCalled = true;
          return { approved: true };
        }
      );
      
      expect(result).toBe(command);
      expect(callbackCalled).toBe(false); // Should not call callback
    });

    test('should handle malformed ${} syntax', async () => {
      const command = 'echo ${INCOMPLETE';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async () => ({ approved: true })
      );
      
      expect(result).toBe(command); // Should not modify
    });

    test('should handle nested ${}', async () => {
      const command = 'echo "${OPENAI_API_KEY:-${FALLBACK}}"';
      
      const result = await substituteCustomKeysWithPermission(
        command,
        testKeys,
        testContext,
        async () => ({ approved: true })
      );
      
      // Should substitute OPENAI_API_KEY (if parser supports nested syntax)
      // For now, just verify it doesn't throw
      expect(result).toBeTruthy();
    });
  });
});
