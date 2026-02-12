#!/usr/bin/env tsx
/**
 * Test PAPR Memory SDK summarization behavior
 * Tests how summaries are generated with different message counts
 */
import { PaprMemoryProvider } from '../src/gateway/services/storage/PaprMemoryProvider';
import type { MessageStoreParams } from '@papr/memory';
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env.local') });

const TEST_CHAT_ID = `summary-test-${Date.now()}`;
const PAPR_API_KEY = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;

async function testSummarization() {
  console.log('🧪 Testing PAPR Memory Summarization Behavior\n');

  if (!PAPR_API_KEY) {
    console.error('❌ No PAPR API key found!');
    console.error('   Set PAPR_API_KEY or PAPR_MEMORY_API_KEY in .env.local');
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
    // Test 1: Send 1 message and check summary
    console.log('📝 Test 1: Sending 1 message...');
    await provider._client.messages.store({
      content: 'Hello, I want to build a React app.',
      role: 'user',
      sessionId: TEST_CHAT_ID,
      process_messages: true,
    });
    
    let summary = await provider.fetchAndCacheSummary(TEST_CHAT_ID);
    console.log('✓ Summary with 1 message:');
    console.log(`  Short term: ${summary?.short_term}`);
    console.log(`  Topics: ${summary?.topics?.join(', ')}`);
    console.log(`  Has medium_term: ${!!summary?.medium_term}`);
    console.log(`  Has long_term: ${!!summary?.long_term}\n`);

    // Test 2: Send 5 more messages (total 6) and check summary
    console.log('📝 Test 2: Sending 5 more messages (total 6)...');
    const messages = [
      { role: 'assistant', content: 'I can help you build a React app. What features do you need?' },
      { role: 'user', content: 'I need a todo list with authentication.' },
      { role: 'assistant', content: 'Great! We can use Firebase for authentication and Firestore for data.' },
      { role: 'user', content: 'What about styling?' },
      { role: 'assistant', content: 'I recommend Tailwind CSS for modern, utility-first styling.' },
    ];

    for (const msg of messages) {
      await provider._client.messages.store({
        content: msg.content,
        role: msg.role as 'user' | 'assistant',
        sessionId: TEST_CHAT_ID,
        process_messages: true,
      });
    }

    summary = await provider.fetchAndCacheSummary(TEST_CHAT_ID);
    console.log('✓ Summary with 6 messages:');
    console.log(`  Short term: ${summary?.short_term?.substring(0, 100)}...`);
    console.log(`  Topics: ${summary?.topics?.join(', ')}`);
    console.log(`  Has medium_term: ${!!summary?.medium_term}`);
    console.log(`  Has long_term: ${!!summary?.long_term}\n`);

    // Test 3: Send 10 more messages (total 16) and check summary
    console.log('📝 Test 3: Sending 10 more messages (total 16)...');
    const moreMessages = [
      { role: 'user', content: 'Can we add dark mode?' },
      { role: 'assistant', content: 'Yes, we can use Tailwind dark mode classes.' },
      { role: 'user', content: 'What about responsive design?' },
      { role: 'assistant', content: 'Tailwind is mobile-first by default.' },
      { role: 'user', content: 'How do we deploy this?' },
      { role: 'assistant', content: 'Vercel is great for React apps.' },
      { role: 'user', content: 'What about testing?' },
      { role: 'assistant', content: 'We can use Vitest for unit tests.' },
      { role: 'user', content: 'And E2E testing?' },
      { role: 'assistant', content: 'Playwright is excellent for E2E.' },
    ];

    for (const msg of moreMessages) {
      await provider._client.messages.store({
        content: msg.content,
        role: msg.role as 'user' | 'assistant',
        sessionId: TEST_CHAT_ID,
        process_messages: true,
      });
    }

    summary = await provider.fetchAndCacheSummary(TEST_CHAT_ID);
    console.log('✓ Summary with 16 messages (past the 15-message threshold):');
    console.log(`  Short term: ${summary?.short_term?.substring(0, 100)}...`);
    console.log(`  Topics: ${summary?.topics?.join(', ')}`);
    console.log(`  Has medium_term: ${!!summary?.medium_term}`);
    console.log(`  Has long_term: ${!!summary?.long_term}`);
    
    if (summary?.medium_term) {
      console.log(`  Medium term: ${summary.medium_term.substring(0, 100)}...`);
    }
    if (summary?.long_term) {
      console.log(`  Long term: ${summary.long_term.substring(0, 100)}...`);
    }

    // Get final stats
    const stats = await provider.getChatStats(TEST_CHAT_ID);
    console.log(`\n📊 Final chat stats:`, stats);

    console.log('\n✅ All summarization tests completed!');
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
    process.exit(1);
  }
}

// Run tests
testSummarization().catch(console.error);
