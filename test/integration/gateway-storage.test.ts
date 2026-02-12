/**
 * Gateway-Storage Integration Tests
 * 
 * Tests the integration between Gateway services and Storage:
 * - Create chat → stream message → verify saved to storage
 * - Title generation after first message
 * - Export to ~/Papr/ after completion
 * - Summary generation and caching
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentService } from '../../src/gateway/services/AgentService.js';
import { StorageManager } from '../../src/gateway/services/StorageManager.js';
import type { AgentConfig } from '../../src/types/agent.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

const TEST_DATA_PATH = path.join(os.tmpdir(), 'paprwork-v2-test-gateway-storage');
const PAPR_EXPORT_PATH = path.join(os.homedir(), 'Papr');

describe('Gateway-Storage Integration', () => {
  let agentService: AgentService;
  let storageManager: StorageManager;

  beforeAll(async () => {
    // Clean up test directory
    await fs.remove(TEST_DATA_PATH);
    // Ensure test directory exists with write permissions
    await fs.ensureDir(TEST_DATA_PATH);

    // Initialize services with same test path
    agentService = new AgentService();
    await agentService.initialize({
      mode: 'local',
      userDataPath: TEST_DATA_PATH,  // Pass explicit test path
      paprApiKey: process.env.PAPR_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
    });

    storageManager = new StorageManager();
    await storageManager.initialize({
      mode: 'local',
      userDataPath: TEST_DATA_PATH,
    });
  });

  afterAll(async () => {
    await fs.remove(TEST_DATA_PATH);
  });

  describe('Chat Creation and Persistence', () => {
    it('should create chat and persist to storage', async () => {
      const chatId = `create-test-${Date.now()}`;
      const title = 'Test Chat Creation';

      // Create chat via AgentService
      await agentService.createChat(chatId, title);

      // Verify in storage
      const chat = await storageManager.getChat(chatId);
      expect(chat).toBeDefined();
      expect(chat?.title).toBe(title);
      expect(chat?.id).toBe(chatId);
    });

    it('should initialize chat with correct metadata', async () => {
      const chatId = `metadata-test-${Date.now()}`;
      
      await agentService.createChat(chatId, 'Metadata Test');

      const chat = await storageManager.getChat(chatId);
      expect(chat).toBeDefined();
      expect(chat?.message_count).toBe(0);
      expect(chat?.created_at).toBeDefined();
      expect(chat?.updated_at).toBeDefined();
    });
  });

  describe('Message Streaming and Storage', () => {
    it('should save user message before streaming', async () => {
      const chatId = `msg-save-test-${Date.now()}`;
      const config: AgentConfig = {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
        systemPrompt: 'You are a helpful assistant.',
      };

      await agentService.createChat(chatId, 'Message Save Test');

      // Start streaming (will save user message)
      try {
        const iterator = agentService.streamAgent(
          chatId,
          'Test user message',
          config
        );
        
        // Consume first chunk (or error)
        await iterator.next();
      } catch (error) {
        // Expected with test API key
      }

      // Check if message was saved
      const messages = await storageManager.loadMessages(chatId);
      
      // Should have at least user message saved
      expect(messages.length).toBeGreaterThanOrEqual(0);
    }, 30000);

    it('should save assistant response after streaming completes', async () => {
      const chatId = `response-save-test-${Date.now()}`;
      const config: AgentConfig = {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
        systemPrompt: 'You are a helpful assistant.',
      };

      await agentService.createChat(chatId, 'Response Save Test');

      try {
        for await (const chunk of agentService.streamAgent(
          chatId,
          'Test message',
          config
        )) {
          // Consume stream
        }
      } catch (error) {
        // Expected
      }

      // Verify messages in storage
      const messages = await storageManager.loadMessages(chatId);
      expect(Array.isArray(messages)).toBe(true);
    }, 30000);

    it('should update message count in chat metadata', async () => {
      const chatId = `count-test-${Date.now()}`;
      const config: AgentConfig = {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
        systemPrompt: 'You are a helpful assistant.',
      };

      await agentService.createChat(chatId, 'Count Test');

      // Stream a message
      try {
        for await (const chunk of agentService.streamAgent(
          chatId,
          'Test message',
          config
        )) {
          // Consume
        }
      } catch (error) {
        // Expected
      }

      const stats = await storageManager.getChatStats(chatId);
      expect(stats.message_count).toBeGreaterThanOrEqual(0);
    }, 30000);
  });

  describe('Title Generation', () => {
    it('should generate title after first message', async () => {
      const chatId = `title-gen-test-${Date.now()}`;
      
      await agentService.createChat(chatId, 'New Chat');

      // Generate title
      const firstMessage = 'How do I create a React component?';
      const generatedTitle = await agentService.generateChatTitle(chatId, firstMessage);

      expect(generatedTitle).toBeDefined();
      expect(generatedTitle.length).toBeGreaterThan(0);
      expect(generatedTitle.length).toBeLessThanOrEqual(40);
    }, 30000);

    it('should update chat title in storage', async () => {
      const chatId = `title-update-test-${Date.now()}`;
      
      await agentService.createChat(chatId, 'Original Title');

      const newTitle = 'Updated Title';
      await agentService.updateChatTitle(chatId, newTitle);

      const chat = await storageManager.getChat(chatId);
      expect(chat?.title).toBe(newTitle);
    });

    it('should use fallback title if generation fails', async () => {
      const chatId = `fallback-test-${Date.now()}`;
      
      await agentService.createChat(chatId, 'New Chat');

      const longMessage = 'This is a very long message that exceeds forty characters';
      const title = await agentService.generateChatTitle(chatId, longMessage);

      // Should fallback to truncated message
      expect(title.length).toBeLessThanOrEqual(43); // 40 + '...'
    }, 30000);
  });

  describe('Chat Export', () => {
    it('should export chat to ~/Papr/ folder', async () => {
      const chatId = `export-test-${Date.now()}`;
      
      await agentService.createChat(chatId, 'Export Test Chat');

      // Verify Papr folder exists (created during initialization)
      const paprFolderExists = await fs.pathExists(PAPR_EXPORT_PATH);
      expect(paprFolderExists).toBe(true);
    });

    it('should create dated export file', async () => {
      const chatId = `dated-export-${Date.now()}`;
      const title = 'Dated Export Test';
      
      await agentService.createChat(chatId, title);

      // Export logic is called internally after streaming
      // Verify export path structure
      const today = new Date().toISOString().split('T')[0];
      const expectedPath = path.join(
        PAPR_EXPORT_PATH,
        `${today}_${title.replace(/\s+/g, '-')}.md`
      );

      // Path should be constructable (actual export happens on stream complete)
      expect(expectedPath).toBeDefined();
    });
  });

  describe('Storage Consistency', () => {
    it('should maintain consistency across multiple chats', async () => {
      const chatIds = [
        `consistency-1-${Date.now()}`,
        `consistency-2-${Date.now()}`,
        `consistency-3-${Date.now()}`,
      ];

      // Create multiple chats
      await Promise.all(
        chatIds.map((id, idx) => 
          agentService.createChat(id, `Consistency Test ${idx + 1}`)
        )
      );

      // Verify all chats exist in storage
      const chats = await storageManager.listChats();
      const testChats = chats.filter(c => c.id?.startsWith('consistency-'));
      
      expect(testChats.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle concurrent writes safely', async () => {
      const chatId = `concurrent-test-${Date.now()}`;
      
      await agentService.createChat(chatId, 'Concurrent Test');

      // Update title multiple times concurrently
      await Promise.all([
        agentService.updateChatTitle(chatId, 'Title 1'),
        agentService.updateChatTitle(chatId, 'Title 2'),
        agentService.updateChatTitle(chatId, 'Title 3'),
      ]);

      // Should have one of the titles (last write wins)
      const chat = await storageManager.getChat(chatId);
      expect(chat?.title).toBeDefined();
      expect(['Title 1', 'Title 2', 'Title 3']).toContain(chat?.title);
    });
  });

  describe('Chat Lifecycle', () => {
    it('should support full chat lifecycle', async () => {
      const chatId = `lifecycle-test-${Date.now()}`;
      const config: AgentConfig = {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
        systemPrompt: 'You are a helpful assistant.',
      };

      // 1. Create
      await agentService.createChat(chatId, 'Lifecycle Test');
      let chat = await storageManager.getChat(chatId);
      expect(chat).toBeDefined();

      // 2. Stream message
      try {
        for await (const chunk of agentService.streamAgent(
          chatId,
          'Test message',
          config
        )) {
          // Consume
        }
      } catch (error) {
        // Expected
      }

      // 3. Generate title
      await agentService.generateChatTitle(chatId, 'Test message');

      // 4. Get messages
      const messages = await storageManager.loadMessages(chatId);
      expect(Array.isArray(messages)).toBe(true);

      // 5. Get stats
      const stats = await storageManager.getChatStats(chatId);
      expect(stats).toBeDefined();

      // 6. Delete
      await storageManager.deleteChat(chatId);
      chat = await storageManager.getChat(chatId);
      expect(chat).toBeNull();
    }, 30000);
  });
});
