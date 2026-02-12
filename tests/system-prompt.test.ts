/**
 * System Prompt Tests
 * 
 * Tests for SystemPrompt builder and content
 */

import { describe, test, expect } from 'vitest';
import { buildSystemPrompt } from '../src/core/agents/SystemPrompt.js';

describe('System Prompt Builder', () => {
  describe('Basic Prompt Generation', () => {
    test('should generate a complete prompt', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(1000); // Should be substantial
      expect(typeof prompt).toBe('string');
    });

    test('should include identity section', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('Papr');
      expect(prompt).toContain('assistant');
    });

    test('should include tool call style guidelines', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('tool');
      expect(prompt.toLowerCase()).toContain('use');
    });
  });

  describe('API Key Documentation', () => {
    test('should include API keys section', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('# 🔑 API Keys');
      expect(prompt).toContain('API Keys & Credentials');
    });

    test('should document ${KEY_NAME} syntax', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('${KEY_NAME}');
      expect(prompt).toContain('${OPENAI_API_KEY}');
    });

    test('should explain permission system', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('Permission System');
      expect(prompt).toContain('"ask"');
      expect(prompt).toContain('"always"');
    });

    test('should list environment keys', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('OPENAI_API_KEY');
      expect(prompt).toContain('ANTHROPIC_API_KEY');
      expect(prompt).toContain('PAPR_API_KEY');
    });

    test('should include custom keys when provided', () => {
      const prompt = buildSystemPrompt({
        customKeys: [
          { name: 'CUSTOM_API_KEY', description: 'My custom API key' },
          { name: 'SECRET_TOKEN', description: 'Secret token' },
        ],
      });
      
      expect(prompt).toContain('CUSTOM_API_KEY');
      expect(prompt).toContain('SECRET_TOKEN');
      expect(prompt).toContain('My custom API key');
    });
  });

  describe('Tool Documentation', () => {
    test('should include bash tool documentation', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('bash');
      expect(prompt).toContain('Bash Tool');
    });

    test('should include filesystem tools documentation', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('Filesystem');
      expect(prompt).toContain('read_file');
      expect(prompt).toContain('write_file');
    });

    test('should include tool examples', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('curl');
      expect(prompt).toContain('npm');
    });

    test('should include available tools when provided', () => {
      const prompt = buildSystemPrompt({
        availableTools: ['bash', 'read_file', 'write_file', 'custom_tool'],
      });
      
      expect(prompt).toContain('bash');
      expect(prompt).toContain('read_file');
      expect(prompt).toContain('write_file');
    });
  });

  describe('Security Guidelines', () => {
    test('should include security section', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('Security');
      expect(prompt).toContain('Safety');
    });

    test('should warn about key sanitization', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('sanitized');
      expect(prompt).toContain('***');
    });

    test('should mention permission denials', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('denied');
      expect(prompt).toContain('permission');
    });
  });

  describe('Agent Behavior Guidelines', () => {
    test('should include behavior guidelines', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('Behavior');
      expect(prompt).toContain('Guidelines');
    });

    test('should include narration guidelines', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('Narration');
    });
  });

  describe('Options and Customization', () => {
    test('should accept workspace path', () => {
      const prompt = buildSystemPrompt({
        workspacePath: '/Users/test/project',
      });
      
      expect(prompt).toBeTruthy();
      // Workspace path might be used in context
    });

    test('should accept user data path', () => {
      const prompt = buildSystemPrompt({
        userDataPath: '/Users/test/.paprwork',
      });
      
      expect(prompt).toBeTruthy();
    });

    test('should work with minimal options', () => {
      const prompt = buildSystemPrompt({});
      
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(1000);
    });

    test('should work with all options', () => {
      const prompt = buildSystemPrompt({
        userDataPath: '/test/.paprwork',
        workspacePath: '/test/project',
        availableTools: ['bash', 'read_file'],
        customKeys: [
          { name: 'MY_KEY', description: 'Test key' },
        ],
      });
      
      expect(prompt).toBeTruthy();
      expect(prompt).toContain('MY_KEY');
      expect(prompt).toContain('bash');
    });
  });

  describe('Content Structure', () => {
    test('should have proper markdown structure', () => {
      const prompt = buildSystemPrompt();
      
      // Should have headers
      expect(prompt).toContain('#');
      expect(prompt).toContain('##');
    });

    test('should have code blocks', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('```');
      expect(prompt).toContain('```bash');
    });

    test('should have consistent formatting', () => {
      const prompt = buildSystemPrompt();
      
      // Check for proper line breaks
      expect(prompt).toContain('\n\n');
      
      // Should not have excessive whitespace
      expect(prompt).not.toContain('\n\n\n\n');
    });
  });

  describe('Real-World Usage Examples', () => {
    test('should include curl example with API key', () => {
      const prompt = buildSystemPrompt();
      
      expect(prompt).toContain('curl');
      expect(prompt).toContain('Authorization: Bearer ${OPENAI_API_KEY}');
    });

    test('should include multiple key usage example', () => {
      const prompt = buildSystemPrompt();
      
      // Should have examples of using multiple keys
      const hasMultiKeyExample = 
        prompt.includes('${') && 
        prompt.split('${').length > 3; // Multiple ${KEY} references
      
      expect(hasMultiKeyExample).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty custom keys array', () => {
      const prompt = buildSystemPrompt({
        customKeys: [],
      });
      
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(1000);
    });

    test('should handle undefined options', () => {
      const prompt = buildSystemPrompt(undefined);
      
      expect(prompt).toBeTruthy();
    });

    test('should handle custom keys with special characters', () => {
      const prompt = buildSystemPrompt({
        customKeys: [
          { name: 'KEY_WITH_UNDERSCORE', description: 'Test' },
          { name: 'KEY123', description: 'Test' },
        ],
      });
      
      expect(prompt).toContain('KEY_WITH_UNDERSCORE');
      expect(prompt).toContain('KEY123');
    });
  });

  describe('Consistency', () => {
    test('should generate same prompt for same options', () => {
      const options = {
        userDataPath: '/test',
        workspacePath: '/test/project',
        availableTools: ['bash', 'read_file'],
        customKeys: [{ name: 'TEST_KEY', description: 'Test' }],
      };
      
      const prompt1 = buildSystemPrompt(options);
      const prompt2 = buildSystemPrompt(options);
      
      expect(prompt1).toBe(prompt2);
    });

    test('should be deterministic', () => {
      const prompts = Array(5).fill(0).map(() => buildSystemPrompt());
      
      const allEqual = prompts.every(p => p === prompts[0]);
      expect(allEqual).toBe(true);
    });
  });
});
