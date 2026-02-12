/**
 * Integration Test: Chat Creation & Title Generation Flow (V1 Simplified Approach)
 * 
 * Tests the complete flow:
 * 1. Create permanent chat (no temp ID in backend)
 * 2. Stream first message
 * 3. Generate title
 * 4. Verify title updates
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { getAgentService, initializeAgentService } from '../src/gateway/services/AgentService.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

describe('Chat Creation Flow (V1 Approach)', () => {
  let testDir: string;
  let agentService: ReturnType<typeof getAgentService>;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    // Skip if no API key
    if (!OPENAI_API_KEY) {
      console.log('⚠️  Skipping test - OPENAI_API_KEY not found');
      return;
    }

    // Create temp directory for test
    testDir = path.join(os.tmpdir(), `papr-test-${Date.now()}`);
    await fs.ensureDir(testDir);
    process.env.PAPR_DATA_DIR = testDir;

    // Initialize AgentService
    agentService = getAgentService();
    await initializeAgentService({
      mode: 'local',
      openaiApiKey: OPENAI_API_KEY,
    });

    console.log('✓ Test environment initialized');
  });

  afterAll(async () => {
    // Cleanup
    if (testDir && await fs.pathExists(testDir)) {
      await fs.remove(testDir);
      console.log('✓ Cleaned up test directory');
    }
  });

  it('should create chat, stream message, and generate title (V1 flow)', async () => {
    if (!OPENAI_API_KEY) {
      console.log('⚠️  Test skipped - no API key');
      return;
    }

    console.log('\n🧪 Testing V1 Chat Creation Flow\n');

    // Step 1: Create permanent chat BEFORE streaming (V1 approach)
    console.log('1️⃣  Creating permanent chat (no temp ID)...');
    const chatId = uuidv4(); // Just UUID, no "chat-" prefix
    await agentService.getStorageManager().createChat(chatId, 'New Chat');
    console.log(`   ✓ Created chat: ${chatId}`);

    // Verify it's a clean UUID (no prefix)
    expect(chatId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(chatId).not.toContain('chat-');
    expect(chatId).not.toContain('temp-');

    // Step 2: Stream first message
    console.log('2️⃣  Streaming first message...');
    const userMessage = 'What is the capital of France?';
    const config = {
      provider: 'openai' as const,
      model: 'gpt-4o-mini',
      apiKey: OPENAI_API_KEY,
      systemPrompt: 'You are a helpful assistant.',
    };

    let chunkCount = 0;
    let fullResponse = '';
    const chunks: any[] = [];

    for await (const chunk of agentService.streamAgent(chatId, userMessage, config)) {
      chunkCount++;
      chunks.push(chunk);
      
      if (chunk.type === 'text-delta' && chunk.payload?.text) {
        fullResponse += chunk.payload.text;
      }
    }

    console.log(`   ✓ Received ${chunkCount} chunks`);
    console.log(`   ✓ Response length: ${fullResponse.length} chars`);
    
    // Verify streaming worked
    expect(chunkCount).toBeGreaterThan(0);
    expect(fullResponse.length).toBeGreaterThan(0);
    expect(fullResponse.toLowerCase()).toContain('paris');

    // Verify all chunks have the correct chatId (no temp conversion)
    for (const chunk of chunks) {
      if (chunk.chatId) {
        expect(chunk.chatId).toBe(chatId); // Should always be the permanent ID
      }
    }

    // Step 3: Generate title
    console.log('3️⃣  Generating title...');
    const title = await agentService.generateChatTitle(chatId, userMessage);
    console.log(`   ✓ Generated title: "${title}"`);

    // Verify title makes sense
    expect(title).toBeTruthy();
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThan(100);
    expect(title).not.toBe('New Chat');
    
    // Title should be relevant to the question
    const lowerTitle = title.toLowerCase();
    const relevant = lowerTitle.includes('france') || 
                     lowerTitle.includes('capital') || 
                     lowerTitle.includes('paris') ||
                     lowerTitle.includes('french');
    expect(relevant).toBe(true);

    // Step 4: Verify chat exists with title
    console.log('4️⃣  Verifying chat metadata...');
    const chat = await agentService.getStorageManager().getChat(chatId);
    expect(chat).toBeTruthy();
    expect(chat?.id).toBe(chatId);
    
    // Step 5: Verify messages saved
    console.log('5️⃣  Verifying messages saved...');
    const messages = await agentService.getChatHistory(chatId);
    expect(messages.length).toBe(2); // User + Assistant
    expect(messages[0].message_role).toBe('user');
    expect(messages[0].message).toBe(userMessage);
    expect(messages[1].message_role).toBe('assistant');
    expect(messages[1].message).toContain('Paris');

    console.log('\n✅ All checks passed!\n');
  }, 60000); // 60 second timeout

  it('should handle multiple messages in same chat', async () => {
    if (!OPENAI_API_KEY) {
      console.log('⚠️  Test skipped - no API key');
      return;
    }

    console.log('\n🧪 Testing Multiple Messages\n');

    // Create chat
    const chatId = uuidv4();
    await agentService.getStorageManager().createChat(chatId, 'Test Chat');
    console.log(`✓ Created chat: ${chatId}`);

    // Send first message
    console.log('Sending message 1...');
    let response1 = '';
    for await (const chunk of agentService.streamAgent(
      chatId,
      'What is 2+2?',
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: OPENAI_API_KEY,
        systemPrompt: 'You are a helpful assistant.',
      }
    )) {
      if (chunk.type === 'text-delta' && chunk.payload?.text) {
        response1 += chunk.payload.text;
      }
    }
    console.log(`✓ Response 1: ${response1.substring(0, 50)}...`);

    // Send second message
    console.log('Sending message 2...');
    let response2 = '';
    for await (const chunk of agentService.streamAgent(
      chatId,
      'What is 3+3?',
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: OPENAI_API_KEY,
        systemPrompt: 'You are a helpful assistant.',
      }
    )) {
      if (chunk.type === 'text-delta' && chunk.payload?.text) {
        response2 += chunk.payload.text;
      }
    }
    console.log(`✓ Response 2: ${response2.substring(0, 50)}...`);

    // Verify both messages saved
    const messages = await agentService.getChatHistory(chatId);
    expect(messages.length).toBe(4); // 2 user + 2 assistant
    expect(messages[0].message).toContain('2+2');
    expect(messages[2].message).toContain('3+3');

    console.log('✅ Multiple messages work correctly!\n');
  }, 90000); // 90 second timeout
});
