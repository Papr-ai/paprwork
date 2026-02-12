/**
 * Simple Integration Test: Chat Creation & Title Generation Flow
 * Run with: npx tsx tests/test-chat-flow.ts
 */

import { getAgentService, initializeAgentService } from '../src/gateway/services/AgentService.js';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function main() {
  console.log('\n🧪 Testing V1 Chat Creation Flow\n');
  console.log('='.repeat(60));

  // Skip if no API key
  if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not found in .env.local');
    process.exit(1);
  }

  // Create temp directory
  const testDir = path.join(os.tmpdir(), `papr-test-${Date.now()}`);
  await fs.ensureDir(testDir);
  process.env.PAPR_DATA_DIR = testDir;
  console.log(`📁 Test directory: ${testDir}\n`);

  try {
    // Initialize AgentService
    console.log('⚙️  Initializing AgentService...');
    const agentService = getAgentService();
    await initializeAgentService({
      mode: 'local',
      openaiApiKey: OPENAI_API_KEY,
    });
    console.log('✅ AgentService initialized\n');

    // Step 1: Create permanent chat BEFORE streaming (V1 approach)
    console.log('1️⃣  Creating permanent chat (V1 approach - no temp ID)...');
    const chatId = uuidv4(); // Just UUID, no "chat-" prefix
    await agentService.getStorageManager().createChat(chatId, 'New Chat');
    console.log(`   ✅ Created chat: ${chatId}`);
    
    // Verify clean UUID
    if (chatId.includes('chat-') || chatId.includes('temp-')) {
      throw new Error('❌ Chat ID should be a clean UUID, no prefix!');
    }
    console.log('   ✅ Chat ID is clean (no prefix)\n');

    // Step 2: Stream first message
    console.log('2️⃣  Streaming first message...');
    const userMessage = 'What is the capital of France?';
    const config = {
      provider: 'openai' as const,
      model: 'gpt-4o-mini',
      apiKey: OPENAI_API_KEY,
      systemPrompt: 'You are a helpful assistant. Be concise.',
    };

    let chunkCount = 0;
    let fullResponse = '';
    const allChunks: any[] = [];

    for await (const chunk of agentService.streamAgent(chatId, userMessage, config)) {
      chunkCount++;
      allChunks.push(chunk);
      
      if (chunk.type === 'text-delta' && chunk.payload?.text) {
        fullResponse += chunk.payload.text;
        process.stdout.write(chunk.payload.text); // Show streaming in real-time
      }

      // Verify chatId in every chunk
      if (chunk.chatId && chunk.chatId !== chatId) {
        throw new Error(`❌ Chunk has wrong chatId! Expected ${chatId}, got ${chunk.chatId}`);
      }
    }

    console.log(`\n   ✅ Received ${chunkCount} chunks`);
    console.log(`   ✅ Response length: ${fullResponse.length} chars`);
    
    if (!fullResponse.toLowerCase().includes('paris')) {
      console.warn('   ⚠️  Response might not mention Paris, but continuing...');
    } else {
      console.log('   ✅ Response mentions Paris');
    }

    // Verify no temp ID conversion happened
    const hadTempConversion = allChunks.some(c => c.type === 'chat-created');
    if (hadTempConversion) {
      throw new Error('❌ Found chat-created chunk - temp conversion should NOT happen!');
    }
    console.log('   ✅ No temp ID conversion (correct!)\n');

    // Step 3: Generate title
    console.log('3️⃣  Generating title...');
    const title = await agentService.generateChatTitle(chatId, userMessage);
    console.log(`   ✅ Generated title: "${title}"`);
    
    if (title === 'New Chat' || !title || title.length === 0) {
      throw new Error('❌ Title generation failed or returned default title');
    }
    console.log('   ✅ Title is not default\n');

    // Step 4: Verify messages saved
    console.log('4️⃣  Verifying messages saved...');
    const messages = await agentService.getChatHistory(chatId);
    console.log(`   ✅ Found ${messages.length} messages`);
    
    if (messages.length !== 2) {
      throw new Error(`❌ Expected 2 messages, got ${messages.length}`);
    }
    
    if (messages[0].message_role !== 'user' || messages[1].message_role !== 'assistant') {
      throw new Error('❌ Message roles incorrect');
    }
    console.log('   ✅ User and assistant messages saved correctly\n');

    // Step 5: Send second message (test history)
    console.log('5️⃣  Testing second message with history...');
    let response2 = '';
    for await (const chunk of agentService.streamAgent(
      chatId,
      'What about its famous tower?',
      config
    )) {
      if (chunk.type === 'text-delta' && chunk.payload?.text) {
        response2 += chunk.payload.text;
      }
    }
    console.log(`   ✅ Second message streamed: ${response2.substring(0, 50)}...`);
    
    const messages2 = await agentService.getChatHistory(chatId);
    if (messages2.length !== 4) {
      throw new Error(`❌ Expected 4 messages after second message, got ${messages2.length}`);
    }
    console.log('   ✅ Message history works correctly\n');

    console.log('='.repeat(60));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(60));
    console.log('\n✨ V1 Simplified Approach Works Correctly!\n');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  } finally {
    // Cleanup
    await fs.remove(testDir);
    console.log(`🧹 Cleaned up test directory\n`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
