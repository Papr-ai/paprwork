import Papr from '@papr/memory';

const apiKey = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;
if (!apiKey) {
  console.error('PAPR_API_KEY not set');
  process.exit(1);
}

const client = new Papr({ xAPIKey: apiKey });

// Try finding messages by their PAPR IDs
const messageIds = ['qxDEAQMEBU', 'MExfZ45wRe', 'DPEx2N5G0V', 'ZBUuLqyInA'];
const localChatId = '95992479-4fe0-4acb-883d-5cbea7de5eb7';

console.log('\n=== Testing PAPR sync for chat:', localChatId, '===\n');

// First, let's try to retrieve with the local chat ID
try {
  console.log('Trying to fetch with local chat ID...');
  const response = await client.messages.sessions.retrieveHistory(localChatId, { limit: 100 });
  console.log('✅ Success! Total messages:', response.total_count);
  console.log('Messages returned:', response.messages?.length || 0);
} catch (error) {
  console.log('❌ Failed with local chat ID:', error.message);
}

console.log('\n');
