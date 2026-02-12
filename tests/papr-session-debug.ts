#!/usr/bin/env tsx
/**
 * Debug test - send multiple messages to same session and verify they're stored correctly
 */
import { PaprMemoryProvider } from '../src/gateway/services/storage/PaprMemoryProvider';
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env.local') });

const TEST_CHAT_ID = `debug-session-${Date.now()}`;
const PAPR_API_KEY = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;

async function debugSessionStorage() {
  console.log('🔍 Debug: Testing session message storage\n');

  if (!PAPR_API_KEY) {
    console.error('❌ No PAPR API key found!');
    process.exit(1);
  }

  const provider = new PaprMemoryProvider({
    apiKey: PAPR_API_KEY,
    baseUrl: process.env.PAPR_BASE_URL || 'https://memory.papr.ai',
  });

  await provider.initialize();
  console.log(`✓ Provider initialized`);
  console.log(`  Session ID: ${TEST_CHAT_ID}\n`);

  try {
    // Send 5 messages to the same session
    for (let i = 1; i <= 5; i++) {
      console.log(`📝 Sending message ${i}/5...`);
      const response = await provider._client.messages.store({
        content: `Test message number ${i}`,
        role: i % 2 === 1 ? 'user' : 'assistant',
        sessionId: TEST_CHAT_ID,
        process_messages: true,
      });
      console.log(`   ✓ Stored with ID: ${response.objectId}`);
      console.log(`   ✓ Session ID: ${response.sessionId || TEST_CHAT_ID}`);
      
      // Wait a bit between messages
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('\n📖 Loading messages back...');
    const messages = await provider.loadMessages(TEST_CHAT_ID);
    console.log(`✓ Retrieved ${messages.length} message(s)`);
    messages.forEach((msg, idx) => {
      console.log(`   ${idx + 1}. [${msg.message_role}]: ${msg.content?.substring(0, 50)}`);
    });

    console.log('\n📊 Getting chat stats...');
    const stats = await provider.getChatStats(TEST_CHAT_ID);
    console.log(`✓ Stats:`, stats);

    console.log(`\n✅ Test complete!`);
    console.log(`\n🔗 Session ID: ${TEST_CHAT_ID}`);
    console.log(`   Check Parse Dashboard for this sessionId to verify:
   1. Only ONE Chat object exists with this sessionId
   2. Chat.messageCount matches the actual message count
   3. All PostMessage objects point to the same Chat object`);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.status) {
      console.error(`   HTTP Status: ${error.status}`);
    }
    if (error.error) {
      console.error(`   Error details:`, JSON.stringify(error.error, null, 2));
    }
    process.exit(1);
  }
}

debugSessionStorage().catch(console.error);
