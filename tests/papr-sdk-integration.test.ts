#!/usr/bin/env tsx
/**
 * Test PAPR Memory SDK Integration
 * 
 * This script tests the PaprMemoryProvider with the official SDK
 */

import { PaprMemoryProvider } from '../src/gateway/services/storage/PaprMemoryProvider';
import type { StoredMessage } from '../src/gateway/services/storage/IStorageProvider';
import Papr, { type MessageStoreParams } from '@papr/memory';
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local
config({ path: join(__dirname, '..', '.env.local') });

const TEST_CHAT_ID = `test-${Date.now()}`; // Simplified session ID
const PAPR_API_KEY = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;

async function testPaprSDK() {
  console.log('🧪 Testing PAPR Memory SDK Integration\n');
  
  if (!PAPR_API_KEY) {
    console.error('❌ PAPR_API_KEY not found in .env.local');
    console.log('Please add PAPR_API_KEY=your-api-key to .env.local');
    process.exit(1);
  }

  console.log('✓ API Key found');
  console.log(`  Using base URL: ${process.env.PAPR_BASE_URL || 'https://memory.papr.ai'}`);
  console.log(`  Session ID: ${TEST_CHAT_ID}\n`);
  
  // Initialize provider
  const provider = new PaprMemoryProvider({
    apiKey: PAPR_API_KEY,
    baseUrl: process.env.PAPR_BASE_URL || 'https://memory.papr.ai',
  });

  await provider.initialize();
  console.log('✓ Provider initialized\n');

  try {
    // Test 1: Save a message using SDK types
    console.log('📝 Test 1: Saving a message...');
    
    // Use proper SDK types
    const messageParams: MessageStoreParams = {
      content: 'Hello from PAPR SDK test!',
      role: 'user',
      sessionId: TEST_CHAT_ID,
      process_messages: true,
      // Optional: add metadata for better tracking
      metadata: {
        sourceUrl: 'paprwork-v2-integration-test',
        user_id: 'test-user',
      },
    };

    console.log('  Request params:', JSON.stringify(messageParams, null, 2));

    const response = await provider._client.messages.store(messageParams);

    console.log(`✓ Message saved with PAPR ID: ${response.objectId}`);
    console.log(`✓ Session ID: ${response.sessionId}`);
    console.log(`✓ Processing status: ${response.processing_status || 'N/A'}\n`);

    // Test 2: Load messages
    console.log('📖 Test 2: Loading messages...');
    const messages = await provider.loadMessages(TEST_CHAT_ID);
    console.log(`✓ Loaded ${messages.length} message(s)`);
    if (messages.length > 0) {
      console.log(`  - First message: "${messages[0].content.substring(0, 50)}..."\n`);
    }

    // Test 3: Get chat stats
    console.log('📊 Test 3: Getting chat stats...');
    const stats = await provider.getChatStats(TEST_CHAT_ID);
    console.log(`✓ Chat stats:`, stats, '\n');

    // Test 4: Try to fetch summary (may not exist for new chat)
    console.log('📚 Test 4: Fetching summary...');
    const summary = await provider.fetchAndCacheSummary(TEST_CHAT_ID);
    if (summary) {
      console.log('✓ Summary fetched:', {
        short_term: summary.short_term?.substring(0, 50) + '...',
        topics: summary.topics,
      });
    } else {
      console.log('ℹ️  No summary available (chat too new, needs ~15 messages)');
    }

    console.log('\n✅ All tests passed!');
    console.log(`\n🔗 Test chat ID: ${TEST_CHAT_ID}`);
    console.log('You can view this chat in your PAPR Memory dashboard');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    if (error.status) {
      console.error(`   HTTP Status: ${error.status}`);
    }
    if (error.error) {
      console.error(`   Error details:`, JSON.stringify(error.error, null, 2));
    }
    console.error('\n💡 Tip: Check if your API key has the correct permissions');
    console.error('   Visit https://platform.papr.ai to verify your API key');
    process.exit(1);
  }
}

// Run tests
testPaprSDK().catch(console.error);
