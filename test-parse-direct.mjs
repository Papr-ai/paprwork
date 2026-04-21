#!/usr/bin/env node

import Papr from '@papr/memory';

const PAPR_API_KEY = 'sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I';
const chatId = '0f7ea575-2590-4f35-9818-9bcdcbdcd311';

const client = new Papr({ xAPIKey: PAPR_API_KEY });

console.log('\n🔍 Checking assistant messages in Parse Server directly...\n');

// Get the chat to find its objectId
const chatsResponse = await fetch(
  `https://api.papr.ai/parse/classes/Chat?where=${encodeURIComponent(JSON.stringify({ sessionId: chatId }))}&limit=1`,
  {
    headers: {
      'X-Parse-Application-Id': 'papr-memory',
      'X-Parse-Master-Key': 'master-key-papr-memory-2024'
    }
  }
);

const chatsData = await chatsResponse.json();
if (!chatsData.results || chatsData.results.length === 0) {
  console.error('Chat not found');
  process.exit(1);
}

const chatObjectId = chatsData.results[0].objectId;
console.log(`Chat objectId: ${chatObjectId}\n`);

// Query PostMessages with NO user filter
const messagesResponse = await fetch(
  `https://api.papr.ai/parse/classes/PostMessage?where=${encodeURIComponent(JSON.stringify({
    chat: {
      __type: "Pointer",
      className: "Chat",
      objectId: chatObjectId
    }
  }))}&order=-createdAt&limit=50&keys=objectId,messageRole,createdAt,user`,
  {
    headers: {
      'X-Parse-Application-Id': 'papr-memory',
      'X-Parse-Master-Key': 'master-key-papr-memory-2024'
    }
  }
);

const messagesData = await messagesResponse.json();
console.log(`Total messages found (no user filter): ${messagesData.results.length}\n`);

// Count by role
const roleCount = {};
messagesData.results.forEach(m => {
  roleCount[m.messageRole] = (roleCount[m.messageRole] || 0) + 1;
});

console.log('Role distribution:', roleCount);
console.log('\n📋 Last 20 messages:\n');

messagesData.results.slice(0, 20).forEach((m, i) => {
  const userInfo = m.user ? `user=${m.user.objectId}` : 'NO USER';
  console.log(`[${i}] ${m.messageRole} at ${m.createdAt} (${userInfo})`);
});
