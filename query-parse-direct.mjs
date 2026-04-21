import fetch from 'node-fetch';

const PARSE_SERVER_URL = "https://parseserver-staging-223473570766.us-west1.run.app";
const PARSE_APPLICATION_ID = "671e705a-f735-4ec0-8474-15899a475440";
const PARSE_MASTER_KEY = "34009710-e3a3-11eb-ba80-0242ac130004";

const sessionId = '444e1d63-1759-4d1c-a88d-903e01be186b';

// First, find the Chat record
const chatQuery = JSON.stringify({ sessionId });
const chatResponse = await fetch(`${PARSE_SERVER_URL}/parse/classes/Chat?where=${encodeURIComponent(chatQuery)}&limit=1`, {
  headers: {
    'X-Parse-Application-Id': PARSE_APPLICATION_ID,
    'X-Parse-Master-Key': PARSE_MASTER_KEY,
    'Content-Type': 'application/json'
  }
});

const chatData = await chatResponse.json();
if (!chatData.results || chatData.results.length === 0) {
  console.error('Chat not found');
  process.exit(1);
}

const chat = chatData.results[0];
console.log('Chat found:', chat.objectId, 'messageCount:', chat.messageCount);

// Now query ALL PostMessages for this chat (no user filter)
const messageQuery = JSON.stringify({
  chat: {
    __type: 'Pointer',
    className: 'Chat',
    objectId: chat.objectId
  }
});

const messagesResponse = await fetch(`${PARSE_SERVER_URL}/parse/classes/PostMessage?where=${encodeURIComponent(messageQuery)}&order=-createdAt&limit=100`, {
  headers: {
    'X-Parse-Application-Id': PARSE_APPLICATION_ID,
    'X-Parse-Master-Key': PARSE_MASTER_KEY,
    'Content-Type': 'application/json'
  }
});

const messagesData = await messagesResponse.json();
console.log(`\nTotal messages in Parse: ${messagesData.results.length}`);

const roleCount = messagesData.results.reduce((acc, m) => {
  acc[m.messageRole] = (acc[m.messageRole] || 0) + 1;
  return acc;
}, {});

console.log('Role distribution:', roleCount);

console.log('\nAll messages (newest first):');
messagesData.results.forEach((m, i) => {
  const userPointer = m.user?.objectId?.substring(0, 8) || 'unknown';
  console.log(`  [${i}] ${m.messageRole.padEnd(10)} user=${userPointer} ${m.createdAt} - "${m.message?.substring(0, 50) || ''}"`);
});
