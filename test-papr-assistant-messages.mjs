#!/usr/bin/env node

import Papr from '@papr/memory';

const PAPR_API_KEY = 'sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I';
const chatId = '0f7ea575-2590-4f35-9818-9bcdcbdcd311';

const client = new Papr({ xAPIKey: PAPR_API_KEY });

console.log('\n📊 Fetching messages from PAPR...\n');

try {
  const response = await client.messages.sessions.retrieveHistory(chatId, {
    limit: 100,
  });
  
  console.log(`Total messages returned: ${response.messages?.length || 0}`);
  console.log(`Total count in DB: ${response.total_count}`);
  console.log(`Has summary: ${!!response.summaries}\n`);
  
  // Count by role
  const roleCount = {};
  response.messages?.forEach(m => {
    roleCount[m.role] = (roleCount[m.role] || 0) + 1;
  });
  
  console.log('Role distribution:', roleCount);
  console.log('\n📋 Last 20 messages (newest first):\n');
  
  response.messages?.slice(0, 20).forEach((m, i) => {
    const timestamp = m.timestamp || m.createdAt;
    const contentType = Array.isArray(m.content) ? 'array' : typeof m.content;
    const contentLength = typeof m.content === 'string' ? m.content.length : 
                         Array.isArray(m.content) ? m.content.length : 0;
    
    console.log(`[${i}] ${m.role} at ${timestamp}`);
    console.log(`    Content: ${contentType} (${contentLength} ${contentType === 'array' ? 'parts' : 'chars'})`);
    
    if (Array.isArray(m.content) && m.content.length > 0) {
      console.log(`    Parts: ${m.content.map(p => p.type).join(', ')}`);
    }
  });
  
} catch (error) {
  console.error('Error:', error.message);
  if (error.response) {
    console.error('Response:', error.response.data);
  }
}
