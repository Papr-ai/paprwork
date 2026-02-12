/**
 * Security Features Test
 * 
 * Tests Phase 1 critical fixes:
 * 1. API key sanitization
 * 2. Result truncation
 * 3. Custom key substitution
 */

import { describe, test, expect } from 'vitest';
import {
  sanitizeError,
  sanitizeToolOutput,
  truncateResult,
  substituteCustomKeys,
  MAX_TOOL_RESULT_LENGTH,
} from '../src/core/tools/security.js';

describe('Security Features - Phase 1', () => {
  describe('sanitizeError', () => {
    test('should remove API keys from error messages', () => {
      const error = 'Error: Invalid API key sk-abc123xyz456';
      const apiKeys = ['sk-abc123xyz456'];
      
      const sanitized = sanitizeError(error, apiKeys);
      
      expect(sanitized).toBe('Error: Invalid API key ***');
      expect(sanitized).not.toContain('sk-abc123xyz456');
    });

    test('should handle multiple API keys', () => {
      const error = 'Keys: sk-abc123 and anthropic-xyz789';
      const apiKeys = ['sk-abc123', 'anthropic-xyz789'];
      
      const sanitized = sanitizeError(error, apiKeys);
      
      expect(sanitized).toBe('Keys: *** and ***');
    });

    test('should handle API keys in bash output', () => {
      const output = 'OPENAI_API_KEY=sk-secret123\nAPI response received';
      const apiKeys = ['sk-secret123'];
      
      const sanitized = sanitizeError(output, apiKeys);
      
      expect(sanitized).toContain('OPENAI_API_KEY=***');
      expect(sanitized).not.toContain('sk-secret123');
    });

    test('should not modify text without API keys', () => {
      const text = 'Normal error message without keys';
      const apiKeys = ['sk-abc123'];
      
      const sanitized = sanitizeError(text, apiKeys);
      
      expect(sanitized).toBe(text);
    });

    test('should handle empty API keys array', () => {
      const text = 'Error with sk-abc123';
      const apiKeys: string[] = [];
      
      const sanitized = sanitizeError(text, apiKeys);
      
      expect(sanitized).toBe(text);
    });
  });

  describe('truncateResult', () => {
    test('should not truncate short results', () => {
      const result = 'Short result';
      const truncated = truncateResult(result);
      
      expect(truncated).toBe(result);
    });

    test('should truncate long results at MAX_TOOL_RESULT_LENGTH', () => {
      const result = 'a'.repeat(150000); // 150K chars
      const truncated = truncateResult(result);
      
      expect(truncated.length).toBeLessThan(result.length);
      expect(truncated).toContain('characters truncated');
      expect(truncated.substring(0, 100)).toBe('a'.repeat(100));
    });

    test('should include truncation message', () => {
      const result = 'x'.repeat(MAX_TOOL_RESULT_LENGTH + 5000);
      const truncated = truncateResult(result);
      
      expect(truncated).toMatch(/\[... \d{1,3}(,\d{3})* characters truncated/);
    });

    test('should respect custom maxLength', () => {
      const result = 'a'.repeat(200);
      const truncated = truncateResult(result, 100);
      
      expect(truncated.length).toBeLessThan(200);
      expect(truncated).toContain('100 characters truncated');
    });
  });

  describe('substituteCustomKeys', () => {
    test('should substitute ${KEY_NAME} placeholders', () => {
      const command = 'echo ${OPENAI_API_KEY}';
      const keys = { OPENAI_API_KEY: 'sk-abc123' };
      
      const result = substituteCustomKeys(command, keys);
      
      expect(result).toBe('echo sk-abc123');
    });

    test('should substitute multiple keys', () => {
      const command = 'curl -H "X-API-Key: ${API_KEY}" -d "${SECRET}"';
      const keys = {
        API_KEY: 'key123',
        SECRET: 'secret456',
      };
      
      const result = substituteCustomKeys(command, keys);
      
      expect(result).toBe('curl -H "X-API-Key: key123" -d "secret456"');
    });

    test('should handle missing keys gracefully', () => {
      const command = 'echo ${MISSING_KEY}';
      const keys = { OTHER_KEY: 'value' };
      
      const result = substituteCustomKeys(command, keys);
      
      expect(result).toBe(command); // Unchanged
    });

    test('should handle empty keys object', () => {
      const command = 'echo ${KEY}';
      const keys = {};
      
      const result = substituteCustomKeys(command, keys);
      
      expect(result).toBe(command);
    });

    test('should handle real-world curl example', () => {
      const command = 'curl https://api.openai.com/v1/models -H "Authorization: Bearer ${OPENAI_API_KEY}"';
      const keys = { OPENAI_API_KEY: 'sk-proj-abc123' };
      
      const result = substituteCustomKeys(command, keys);
      
      expect(result).toContain('Bearer sk-proj-abc123');
      expect(result).not.toContain('${OPENAI_API_KEY}');
    });
  });

  describe('sanitizeToolOutput', () => {
    test('should sanitize string output', () => {
      const output = 'Result contains key sk-abc123';
      const apiKeys = ['sk-abc123'];
      
      const sanitized = sanitizeToolOutput(output, apiKeys);
      
      expect(sanitized).toBe('Result contains key ***');
    });

    test('should sanitize nested object', () => {
      const output = {
        stdout: 'Key: sk-abc123',
        stderr: 'Error: Invalid key sk-abc123',
        data: {
          nested: 'Another sk-abc123 here',
        },
      };
      const apiKeys = ['sk-abc123'];
      
      const sanitized = sanitizeToolOutput(output, apiKeys) as any;
      
      expect(sanitized.stdout).toBe('Key: ***');
      expect(sanitized.stderr).toBe('Error: Invalid key ***');
      expect(sanitized.data.nested).toBe('Another *** here');
    });

    test('should sanitize arrays', () => {
      const output = ['key1: sk-abc123', 'key2: sk-abc123'];
      const apiKeys = ['sk-abc123'];
      
      const sanitized = sanitizeToolOutput(output, apiKeys) as string[];
      
      expect(sanitized[0]).toBe('key1: ***');
      expect(sanitized[1]).toBe('key2: ***');
    });

    test('should handle mixed types', () => {
      const output = {
        text: 'Key sk-abc123',
        count: 42,
        success: true,
        items: ['item with sk-abc123', 'clean item'],
      };
      const apiKeys = ['sk-abc123'];
      
      const sanitized = sanitizeToolOutput(output, apiKeys) as any;
      
      expect(sanitized.text).toBe('Key ***');
      expect(sanitized.count).toBe(42); // Numbers unchanged
      expect(sanitized.success).toBe(true); // Booleans unchanged
      expect(sanitized.items[0]).toBe('item with ***');
      expect(sanitized.items[1]).toBe('clean item');
    });
  });

  describe('Integration: Bash Tool Security', () => {
    test('should sanitize and truncate bash output', () => {
      // Simulate bash tool output with API key
      const bashOutput = {
        stdout: 'OPENAI_API_KEY=sk-abc123xyz\n' + 'x'.repeat(150000),
        stderr: '',
        exitCode: 0,
      };
      const apiKeys = ['sk-abc123xyz'];
      
      // Sanitize
      const sanitized = sanitizeToolOutput(bashOutput, apiKeys) as any;
      
      expect(sanitized.stdout).toContain('OPENAI_API_KEY=***');
      expect(sanitized.stdout).not.toContain('sk-abc123xyz');
      
      // Truncate
      const truncated = truncateResult(sanitized.stdout);
      expect(truncated.length).toBeLessThan(bashOutput.stdout.length);
    });

    test('should substitute keys before execution', () => {
      const command = 'curl -H "Authorization: Bearer ${OPENAI_API_KEY}" https://api.openai.com';
      const keys = { OPENAI_API_KEY: 'sk-real-key' };
      
      const substituted = substituteCustomKeys(command, keys);
      
      expect(substituted).toContain('Bearer sk-real-key');
      
      // Then sanitize the result
      const output = `Command: ${substituted}\nSuccess`;
      const sanitized = sanitizeError(output, [keys.OPENAI_API_KEY]);
      
      expect(sanitized).toContain('Bearer ***');
    });
  });

  describe('Edge Cases', () => {
    test('should handle null/undefined gracefully', () => {
      expect(sanitizeToolOutput(null, [])).toBe(null);
      expect(sanitizeToolOutput(undefined, [])).toBe(undefined);
    });

    test('should handle special regex characters in API keys', () => {
      const text = 'Key: sk-abc$123.xyz*';
      const apiKeys = ['sk-abc$123.xyz*'];
      
      const sanitized = sanitizeError(text, apiKeys);
      
      expect(sanitized).toBe('Key: ***');
    });

    test('should handle very long API keys', () => {
      const longKey = 'sk-' + 'a'.repeat(500);
      const text = `Error with ${longKey}`;
      
      const sanitized = sanitizeError(text, [longKey]);
      
      expect(sanitized).toBe('Error with ***');
    });

    test('should handle empty strings', () => {
      expect(sanitizeError('', ['key'])).toBe('');
      expect(truncateResult('')).toBe('');
      expect(substituteCustomKeys('', {})).toBe('');
    });
  });
});
