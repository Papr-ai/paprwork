import Papr from '@papr/memory';

const apiKey = process.env.PAPR_API_KEY || process.env.PAPR_MEMORY_API_KEY;
if (!apiKey) {
  console.error('PAPR_API_KEY not set');
  process.exit(1);
}

const client = new Papr({ xAPIKey: apiKey });
const chatId = '95992479-4fe0-4acb-883d-5cbea7de5eb7';

console.log('\n=== Fetching chat from PAPR ===\n');

try {
  const response = await client.messages.sessions.retrieveHistory(chatId, { limit: 100 });

  console.log('Total messages in PAPR:', response.total_count);
  console.log('Messages returned:', response.messages?.length || 0);
  console.log('Has summaries:', !!response.summaries);
  console.log('Has context_for_llm:', !!response.context_for_llm);
  
  if (response.summaries) {
    console.log('\n=== SUMMARY CONTENT ===');
    console.log('Short term length:', response.summaries.short_term?.length || 0);
    console.log('Medium term length:', response.summaries.medium_term?.length || 0);
    console.log('Long term length:', response.summaries.long_term?.length || 0);
    console.log('Topics:', response.summaries.topics);
    if (response.summaries.long_term) {
      console.log('\nLong term summary (first 500 chars):');
      console.log(response.summaries.long_term.substring(0, 500) + '...');
    }
  }
  
  console.log('\n=== MESSAGES (ordered by PAPR, newest first) ===');
  response.messages.forEach((m, i) => {
    const content = typeof m.content === 'string' 
      ? m.content.substring(0, 60)
      : `Array[${m.content?.length || 0}]`;
    console.log(`[${i}] ${m.role.padEnd(10)} | ${m.createdAt} | ${content}...`);
  });
  
} catch (error) {
  console.error('Error:', error.message);
  console.error(error);
}
