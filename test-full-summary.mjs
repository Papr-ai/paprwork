import Papr from '@papr/memory';

const apiKey = "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I";
const client = new Papr({ xAPIKey: apiKey });
const chatId = '95992479-4fe0-4acb-883d-5cbea7de5eb7';

const response = await client.messages.sessions.retrieveHistory(chatId, { limit: 100 });

console.log('\n=== FULL SUMMARY ===\n');
console.log('SHORT TERM (last 15 messages):');
console.log(response.summaries.short_term);
console.log('\n---\n');
console.log('MEDIUM TERM (last ~100 messages):');
console.log(response.summaries.medium_term);
console.log('\n---\n');
console.log('LONG TERM (full session):');
console.log(response.summaries.long_term);
