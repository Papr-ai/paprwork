#!/usr/bin/env tsx
/**
 * Send 20 messages to a single session to test 15+ message summarization
 */
import { PaprMemoryProvider } from '../src/gateway/services/storage/PaprMemoryProvider';
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env.local') });

const TEST_CHAT_ID = `chat-20msgs-${Date.now()}`;
const PAPR_API_KEY = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;

async function send20Messages() {
  console.log('🧪 Sending 20 messages to test summarization\n');

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

  // Conversation about building a React app
  const conversation = [
    { role: 'user', content: 'I want to build a modern React app with TypeScript.' },
    { role: 'assistant', content: 'Great! Let\'s start with Vite for fast development. We\'ll use TypeScript for type safety.' },
    { role: 'user', content: 'What state management should I use?' },
    { role: 'assistant', content: 'For a modern app, I recommend Zustand. It\'s lightweight and has great TypeScript support.' },
    { role: 'user', content: 'How about styling?' },
    { role: 'assistant', content: 'Tailwind CSS is perfect for rapid UI development with utility classes.' },
    { role: 'user', content: 'I need authentication. What do you recommend?' },
    { role: 'assistant', content: 'Firebase Auth is easy to integrate, or you could use Supabase for an open-source option.' },
    { role: 'user', content: 'Let\'s go with Supabase. What about the database?' },
    { role: 'assistant', content: 'Supabase includes PostgreSQL, so you get a powerful relational database out of the box.' },
    { role: 'user', content: 'How do I handle routing?' },
    { role: 'assistant', content: 'React Router v6 is the standard. Use createBrowserRouter for the new data APIs.' },
    { role: 'user', content: 'What about form handling?' },
    { role: 'assistant', content: 'React Hook Form with Zod for validation gives you type-safe forms with minimal re-renders.' },
    { role: 'user', content: 'Should I add testing?' },
    { role: 'assistant', content: 'Yes! Use Vitest for unit tests and Playwright for end-to-end testing.' },
    { role: 'user', content: 'How do I deploy this?' },
    { role: 'assistant', content: 'Vercel is perfect for React apps - automatic deployments from GitHub with zero config.' },
    { role: 'user', content: 'What about API calls?' },
    { role: 'assistant', content: 'TanStack Query (React Query) for data fetching, caching, and synchronization.' },
  ];

  try {
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < conversation.length; i++) {
      const msg = conversation[i];
      try {
        console.log(`📝 [${i + 1}/20] Sending ${msg.role} message to session: ${TEST_CHAT_ID}`);
        const response = await provider._client.messages.store({
          content: msg.content,
          role: msg.role as 'user' | 'assistant',
          sessionId: TEST_CHAT_ID,  // ✅ SAME SESSION ID FOR ALL MESSAGES
          process_messages: true,
        });
        console.log(`   ✓ Stored with ID: ${response.objectId} in session ${TEST_CHAT_ID}`);
        successCount++;
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error: any) {
        console.error(`   ❌ Failed: ${error.message}`);
        errorCount++;
      }
    }

    console.log(`\n✅ Sent ${successCount} messages successfully (${errorCount} errors)`);

    // Wait a bit for background processing
    console.log('\n⏳ Waiting 10 seconds for background processing...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log('\n📖 Loading messages back...');
    const messages = await provider.loadMessages(TEST_CHAT_ID);
    console.log(`✓ Retrieved ${messages.length} message(s)`);

    console.log('\n📊 Getting chat stats...');
    const stats = await provider.getChatStats(TEST_CHAT_ID);
    console.log(`✓ Message count: ${stats.message_count}`);
    console.log(`✓ Has summary: ${stats.has_summary}`);

    if (stats.message_count >= 15) {
      console.log('\n🎯 We have 15+ messages! Fetching summary from PAPR compress endpoint...');
      console.log(`   Using session: ${TEST_CHAT_ID}`);
      try {
        const summary = await provider.fetchAndCacheSummary(TEST_CHAT_ID);
        if (summary) {
          console.log('\n✅ Summary fetched from PAPR compress endpoint!');
          console.log(`   Fetched from PAPR: ${summary.fetched_from_papr}`);
          console.log(`\nShort-term (last ~15 messages):\n${summary.short_term}\n`);
          console.log(`Topics: ${summary.topics?.join(', ')}`);
          if (summary.medium_term) {
            console.log(`\nMedium-term:\n${summary.medium_term}\n`);
          }
          if (summary.long_term) {
            console.log(`\nLong-term:\n${summary.long_term}\n`);
          }
        } else {
          console.log('⚠️  No summary available yet (still processing)');
        }
      } catch (error: any) {
        console.log(`⚠️  Summary not ready: ${error.message}`);
      }
    } else {
      console.log(`\n⚠️  Only ${stats.message_count} messages stored. Need 15+ for summarization test.`);
    }

    console.log(`\n✅ Test complete!`);
    console.log(`\n🔗 Session ID: ${TEST_CHAT_ID}`);
    console.log(`   Check Parse Dashboard Chat table for sessionId: "${TEST_CHAT_ID}"`);
    console.log(`   Should have messageCount: ${stats.message_count}`);

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

send20Messages().catch(console.error);
